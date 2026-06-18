#!/usr/bin/env bash
#
# premarket_gappers.sh — premarket gap-and-go scanner
#
# Pipeline:
#   1. WebFetch Yahoo gainers  -> parse {symbol, price, gap_pct, volume, avg_volume}
#   2. Cheap filters (from Yahoo data): gap%, price, premkt volume, RVOL, $-volume
#   3. Keep top N by gap_pct desc (default 10)
#   4. Per-ticker WebFetch Benzinga -> {catalyst, headlines[], atr14}
#   5. Gap-vs-ATR extension filter (fail-open if atr14 missing)
#   6. Write ./premarket_gappers_YYYY-MM-DD.json + print one-line summary
#
# WebFetch is a Claude Code tool, so the script drives the `claude` CLI in
# headless print mode (`claude -p --allowedTools WebFetch`) for the two fetch
# stages. JSON parsing / filtering / assembly is done in embedded Python
# (no jq dependency).
#
# Fail-open philosophy: if Yahoo doesn't expose avg volume -> rvol=null, keep.
# If Benzinga is unreachable for a ticker -> catalyst=null, headlines=[],
# atr14=null, keep (ATR filter skipped). A single ticker failure never aborts.
#
# Usage:
#   ./premarket_gappers.sh              # live scan
#   ./premarket_gappers.sh --self-test  # offline pipeline test (fixtures, no net)
#   ./premarket_gappers.sh --help
#
# Tunable via env (defaults shown):
#   MIN_GAP_PCT=5  MIN_PRICE=3  MIN_PREMARKET_VOLUME=50000
#   MIN_RVOL=5  MIN_DOLLAR_VOLUME=1000000  MAX_ATR_EXTENSION=4  TOP_N=10
#   CLAUDE_BIN=claude  CLAUDE_MODEL=  FETCH_TIMEOUT=45  PY_BIN=python

set -euo pipefail

# ---------------------------------------------------------------- config -----
export MIN_GAP_PCT=${MIN_GAP_PCT:-5}
export MIN_PRICE=${MIN_PRICE:-3}
export MIN_PREMARKET_VOLUME=${MIN_PREMARKET_VOLUME:-50000}
export MIN_RVOL=${MIN_RVOL:-5}
export MIN_DOLLAR_VOLUME=${MIN_DOLLAR_VOLUME:-1000000}
export MAX_ATR_EXTENSION=${MAX_ATR_EXTENSION:-4}
export TOP_N=${TOP_N:-10}
CLAUDE_BIN=${CLAUDE_BIN:-claude}
CLAUDE_MODEL=${CLAUDE_MODEL:-}
FETCH_TIMEOUT=${FETCH_TIMEOUT:-45}
PY_BIN=${PY_BIN:-python}

YAHOO_URL="https://finance.yahoo.com/markets/stocks/gainers/"

SELFTEST=0
case "${1:-}" in
  --self-test) SELFTEST=1 ;;
  --help|-h) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "" ) ;;
  * ) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
esac

export SCANNED_AT
SCANNED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATE=${SCAN_DATE:-$(date +%F)}   # SCAN_DATE lets the scheduler key the file to NY date
OUT="./premarket_gappers_${DATE}.json"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------- dependencies -----
command -v "$PY_BIN" >/dev/null 2>&1 || PY_BIN=python3
command -v "$PY_BIN" >/dev/null 2>&1 || die "python is required"
if [[ $SELFTEST -eq 0 ]]; then
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "'$CLAUDE_BIN' CLI not found on PATH (set CLAUDE_BIN=...)"
fi

run_to() {  # coreutils timeout if present, else passthrough
  if command -v timeout >/dev/null 2>&1; then timeout "$FETCH_TIMEOUT" "$@"; else "$@"; fi
}

claude_fetch() {  # $1 = prompt ; echoes model's raw stdout
  local args=( -p "$1" --allowedTools "WebFetch" --output-format text )
  [[ -n "$CLAUDE_MODEL" ]] && args+=( --model "$CLAUDE_MODEL" )
  run_to "$CLAUDE_BIN" "${args[@]}" 2>/dev/null
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ----------------------------------------------- embedded python helper ------
cat > "$TMP/gappers.py" <<'PY'
import sys, os, json, re

try:  # Windows: avoid \r\n translation and emit UTF-8 (em-dash in summary)
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
except Exception:
    pass

CFG = {k: float(os.environ[k]) for k in (
    'MIN_GAP_PCT','MIN_PRICE','MIN_PREMARKET_VOLUME',
    'MIN_RVOL','MIN_DOLLAR_VOLUME','MAX_ATR_EXTENSION')}
TOP_N = int(float(os.environ.get('TOP_N', '10')))

def clean_json(text):
    t = (text or '').strip()
    t = re.sub(r'^```[a-zA-Z]*\s*$', '', t, flags=re.M).strip()
    try:
        return json.loads(t)
    except Exception:
        pass
    for oc, cc in (('[', ']'), ('{', '}')):
        i, j = t.find(oc), t.rfind(cc)
        if i != -1 and j > i:
            try:
                return json.loads(t[i:j+1])
            except Exception:
                continue
    raise ValueError('no JSON found')

def num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).replace(',', '').replace('%', '').replace('$', '').strip()
    m = re.match(r'^([0-9]*\.?[0-9]+)\s*([KMB]?)$', s, re.I)
    if not m:
        try:
            return float(s)
        except Exception:
            return None
    mult = {'': 1, 'K': 1e3, 'M': 1e6, 'B': 1e9}[m.group(2).upper()]
    return float(m.group(1)) * mult

def fmt(x):
    x = float(x)
    return int(x) if x.is_integer() else round(x, 2)

NULL_BZ = {'catalyst': None, 'headlines': [], 'atr14': None}

def do_filter(src, dst):
    data = clean_json(open(src, encoding='utf-8').read())
    if isinstance(data, dict):  # tolerate {"gainers":[...]} or first list value
        data = data.get('gainers') or next((v for v in data.values() if isinstance(v, list)), [])
    kept = []
    for r in data:
        if not isinstance(r, dict):
            continue
        sym = str(r.get('symbol', '')).strip().upper()
        price, gap, vol = num(r.get('price')), num(r.get('gap_pct')), num(r.get('volume'))
        avg = num(r.get('avg_volume'))
        if not sym or None in (price, gap, vol):
            continue
        if not (gap > CFG['MIN_GAP_PCT'] and price > CFG['MIN_PRICE']
                and vol > CFG['MIN_PREMARKET_VOLUME']):
            continue
        if price * vol < CFG['MIN_DOLLAR_VOLUME']:           # $-volume liquidity gate
            continue
        rvol = (vol / avg) if (avg and avg > 0) else None    # RVOL fails open
        if rvol is not None and rvol < CFG['MIN_RVOL']:
            continue
        kept.append({'symbol': sym, 'price': price, 'gap_pct': gap,
                     'volume': int(vol), 'rvol': rvol})
    kept.sort(key=lambda d: d['gap_pct'], reverse=True)
    kept = kept[:TOP_N]
    json.dump(kept, open(dst, 'w', encoding='utf-8'))
    print(len(kept))

def do_assemble(filtered, bzdir, out):
    rows = json.load(open(filtered, encoding='utf-8'))
    enriched = []
    for r in rows:
        p = os.path.join(bzdir, 'bz_%s.txt' % r['symbol'])
        bz = dict(NULL_BZ)
        if os.path.exists(p):
            try:
                obj = clean_json(open(p, encoding='utf-8').read())
                if isinstance(obj, dict):
                    bz = obj
            except Exception:
                pass
        atr = num(bz.get('atr14'))
        if atr and atr > 0:                                   # ATR-extension filter, fails open
            atr_pct = atr / r['price'] * 100
            if atr_pct > 0 and (r['gap_pct'] / atr_pct) > CFG['MAX_ATR_EXTENSION']:
                continue
        heads = bz.get('headlines') or []
        if not isinstance(heads, list):
            heads = [str(heads)]
        heads = [str(h) for h in heads][:2]
        enriched.append({'symbol': r['symbol'], 'price': round(r['price'], 4),
                         'gap_pct': fmt(r['gap_pct']), 'premarket_volume': r['volume'],
                         'catalyst': bz.get('catalyst'), 'headlines': heads})
    enriched.sort(key=lambda d: d['gap_pct'], reverse=True)
    gappers = [dict(rank=i + 1, **d) for i, d in enumerate(enriched)]
    json.dump({'scanned_at': os.environ.get('SCANNED_AT', ''), 'gappers': gappers},
              open(out, 'w', encoding='utf-8'), indent=2)
    top = ', '.join("%s (%s%%) — %s" % (g['symbol'], g['gap_pct'], g['catalyst'] or 'no catalyst')
                    for g in gappers[:3])
    print("Premarket Gappers: %d names. Top: %s" % (len(gappers), top))

cmd = sys.argv[1] if len(sys.argv) > 1 else ''
if cmd == 'filter':
    do_filter(sys.argv[2], sys.argv[3])
elif cmd == 'assemble':
    do_assemble(sys.argv[2], sys.argv[3], sys.argv[4])
else:
    sys.exit('unknown cmd: %r' % cmd)
PY

# ---------------------------------------------------------- stage 1: rows ----
GAINERS_PROMPT="Use the WebFetch tool on ${YAHOO_URL}
From the day gainers table extract EVERY row. For each row return:
- symbol: ticker string
- price: latest price as a number
- gap_pct: the percent change as a plain number (no % sign, e.g. 7.5)
- volume: share volume as an integer (expand abbreviations: 1.2M -> 1200000, 350K -> 350000)
- avg_volume: the 'Avg Vol (3M)' column as an integer, or null if not present
Output ONLY a compact JSON array and nothing else. No markdown, no prose, no code fences.
Example: [{\"symbol\":\"AAPL\",\"price\":175.2,\"gap_pct\":7.5,\"volume\":1200000,\"avg_volume\":50000000}]"

fetch_gainers() {  # writes raw text to stdout
  if [[ $SELFTEST -eq 1 ]]; then
    cat <<'JSON'
[
 {"symbol":"AAA","price":8.0,"gap_pct":25,"volume":2000000,"avg_volume":100000},
 {"symbol":"BBB","price":4.0,"gap_pct":40,"volume":60000,"avg_volume":50000},
 {"symbol":"CCC","price":6.0,"gap_pct":12,"volume":900000,"avg_volume":null},
 {"symbol":"DDD","price":4.0,"gap_pct":30,"volume":2000000,"avg_volume":150000},
 {"symbol":"EEE","price":50.0,"gap_pct":3,"volume":5000000,"avg_volume":1000000},
 {"symbol":"FFF","price":2.5,"gap_pct":8,"volume":400000,"avg_volume":50000},
 {"symbol":"GGG","price":10.0,"gap_pct":15,"volume":800000,"avg_volume":100000}
]
JSON
    return 0
  fi
  log "WebFetch Yahoo gainers ..."
  claude_fetch "$GAINERS_PROMPT"
}

# ------------------------------------------------- stage 4: per-ticker bz -----
benzinga_prompt() {
  local t="$1"
  cat <<EOF
Use the WebFetch tool on https://www.benzinga.com/quote/${t}
Answer this exactly: "What recent news or catalyst is driving ${t} stock today? Return a one-sentence summary, then up to 2 recent headlines verbatim. Just the data — no commentary."
Also report ATR14 (14-day Average True Range) for ${t} if the page shows it, else null.
Output ONLY this compact JSON object and nothing else (no markdown, no prose, no fences):
{"catalyst":"<one-sentence summary or null>","headlines":["<verbatim headline>"],"atr14":<number or null>}
EOF
}

fetch_benzinga() {  # $1=ticker $2=outfile ; always leaves valid-ish JSON in outfile
  local t="$1" outf="$2"
  if [[ $SELFTEST -eq 1 ]]; then
    case "$t" in
      AAA) echo '{"catalyst":"FDA approval for lead drug","headlines":["AAA Wins FDA Nod","Shares Surge Premarket"],"atr14":1.5}' ;;
      DDD) echo '{"catalyst":"Low-float retail squeeze","headlines":["DDD Trends On Forums"],"atr14":0.2}' ;;
      CCC) echo '{"catalyst":"Announced $50M buyback","headlines":["CCC Board Approves Buyback"],"atr14":null}' ;;
      GGG) echo '{"catalyst":"Beat Q2 earnings, raised guidance","headlines":["GGG Tops Estimates","Analysts Lift Targets"],"atr14":1.0}' ;;
      *)   echo '{"catalyst":null,"headlines":[],"atr14":null}' ;;
    esac > "$outf"
    return 0
  fi
  log "  WebFetch Benzinga: $t"
  if ! claude_fetch "$(benzinga_prompt "$t")" > "$outf" 2>/dev/null || [[ ! -s "$outf" ]]; then
    log "  (catalyst lookup failed for $t -> null)"
    echo '{"catalyst":null,"headlines":[],"atr14":null}' > "$outf"
  fi
}

# ----------------------------------------------------------------- main ------
log "premarket_gappers.sh starting (self-test=$SELFTEST)"

fetch_gainers > "$TMP/rows_raw.txt"
KEPT=$("$PY_BIN" "$TMP/gappers.py" filter "$TMP/rows_raw.txt" "$TMP/filtered.json") \
  || die "failed to parse / filter gainers (raw saved at $TMP/rows_raw.txt)"
log "$KEPT names passed cheap filters (gap>$MIN_GAP_PCT, price>$MIN_PRICE, vol>$MIN_PREMARKET_VOLUME, \$vol>=$MIN_DOLLAR_VOLUME, rvol>=$MIN_RVOL|null); fetching catalysts"

mapfile -t SYMS < <("$PY_BIN" -c "import json,sys;[print(d['symbol']) for d in json.load(open(sys.argv[1]))]" "$TMP/filtered.json" | tr -d '\r')
for sym in "${SYMS[@]:-}"; do
  [[ -z "$sym" ]] && continue
  fetch_benzinga "$sym" "$TMP/bz_${sym}.txt"
done

"$PY_BIN" "$TMP/gappers.py" assemble "$TMP/filtered.json" "$TMP" "$OUT"
log "wrote $OUT"
