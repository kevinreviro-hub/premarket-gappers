#!/usr/bin/env python3
"""slack_notify.py — post a message (and optionally upload a file) to Slack.

Used by run_gappers_scheduled.sh. Stdlib only (urllib) — no pip deps.
Token is read from $SLACK_BOT_TOKEN. File upload uses the current Slack
external-upload flow (files.upload is deprecated):
  files.getUploadURLExternal -> POST bytes to upload_url -> files.completeUploadExternal

Usage:
  SLACK_BOT_TOKEN=xoxb-... python slack_notify.py --channel C05... --text "summary" [--file path.json]

Exit: 0 ok | 1 Slack API error | 2 missing token
"""
import sys, os, json, argparse, uuid, urllib.request, urllib.parse, urllib.error

API = "https://slack.com/api/"
TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")


def _post(url, data, headers):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def api_form(method, params):
    data = urllib.parse.urlencode(params).encode()
    raw = _post(API + method, data, {
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    return json.loads(raw)


def api_json(method, params):
    raw = _post(API + method, json.dumps(params).encode(), {
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json; charset=utf-8",
    })
    return json.loads(raw)


def die(where, resp):
    sys.stderr.write("slack %s failed: %s\n" % (where, resp.get("error") or resp))
    sys.exit(1)


def post_message(channel, text):
    r = api_json("chat.postMessage", {"channel": channel, "text": text})
    if not r.get("ok"):
        die("chat.postMessage", r)


def upload_file(channel, path, text):
    name = os.path.basename(path)
    size = os.path.getsize(path)
    g = api_form("files.getUploadURLExternal", {"filename": name, "length": str(size)})
    if not g.get("ok"):
        die("files.getUploadURLExternal", g)

    with open(path, "rb") as f:
        content = f.read()
    boundary = "----slack" + uuid.uuid4().hex
    body = b"".join([
        ("--" + boundary + "\r\n").encode(),
        ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % name).encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        content, b"\r\n",
        ("--" + boundary + "--\r\n").encode(),
    ])
    _post(g["upload_url"], body, {"Content-Type": "multipart/form-data; boundary=" + boundary})

    c = api_form("files.completeUploadExternal", {
        "files": json.dumps([{"id": g["file_id"], "title": name}]),
        "channel_id": channel,
        "initial_comment": text,
    })
    if not c.get("ok"):
        die("files.completeUploadExternal", c)


def webhook(url, text):
    """Incoming-webhook post: text only, no token, no file."""
    raw = _post(url, json.dumps({"text": text}).encode(), {"Content-Type": "application/json"})
    if raw.strip() != b"ok":
        sys.stderr.write("incoming-webhook failed: %s\n" % raw[:200].decode("utf-8", "replace"))
        sys.exit(1)


def _hvol(v):
    try:
        v = float(v)
    except Exception:
        return str(v)
    for unit, d in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if v >= d:
            return "%.1f%s" % (v / d, unit)
    return str(int(v))


def render_message(path):
    """Build a clean, human-readable Slack message from a gappers JSON file."""
    doc = json.load(open(path, encoding="utf-8"))
    g = doc.get("gappers", []) or []
    date = (doc.get("scanned_at") or "")[:10]
    if not g:
        return ":chart_with_upwards_trend: *Premarket Gappers — %s*\nNo names cleared the filters today." % date
    out = [":chart_with_upwards_trend: *Premarket Gappers — %s*  _(Pluang-tradable)_" % date,
           "%d name%s cleared the filters:" % (len(g), "" if len(g) == 1 else "s"), ""]
    for x in g:
        out.append("*%s* — *%+.2f%%*  ·  $%s  ·  vol %s" % (
            x.get("symbol", "?"), float(x.get("gap_pct", 0)),
            x.get("price", "?"), _hvol(x.get("premarket_volume"))))
        if x.get("catalyst"):
            out.append("> %s" % x["catalyst"])
        for h in (x.get("headlines") or [])[:2]:
            out.append("• _%s_" % h)
        out.append("")
    return "\n".join(out).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel")            # bot-token mode
    ap.add_argument("--webhook")            # incoming-webhook mode (no token)
    ap.add_argument("--text")               # explicit message text
    ap.add_argument("--from-json", dest="from_json")  # render human message from JSON
    ap.add_argument("--file")               # file to attach (bot-token mode only)
    a = ap.parse_args()
    text = render_message(a.from_json) if a.from_json else a.text
    if not text:
        sys.stderr.write("need --text or --from-json\n")
        sys.exit(2)
    try:
        if a.webhook:
            webhook(a.webhook, text)
        elif a.channel:
            if not TOKEN:
                sys.stderr.write("missing SLACK_BOT_TOKEN\n")
                sys.exit(2)
            if a.file and os.path.exists(a.file):
                upload_file(a.channel, a.file, text)
            else:
                post_message(a.channel, text)
        else:
            sys.stderr.write("need --channel (with token) or --webhook\n")
            sys.exit(2)
    except urllib.error.URLError as e:
        sys.stderr.write("slack network error: %s\n" % e)
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
