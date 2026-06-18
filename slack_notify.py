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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel")            # bot-token mode
    ap.add_argument("--webhook")            # incoming-webhook mode (no token)
    ap.add_argument("--text", required=True)
    ap.add_argument("--file")
    a = ap.parse_args()
    try:
        if a.webhook:
            webhook(a.webhook, a.text)
        elif a.channel:
            if not TOKEN:
                sys.stderr.write("missing SLACK_BOT_TOKEN\n")
                sys.exit(2)
            if a.file and os.path.exists(a.file):
                upload_file(a.channel, a.file, a.text)
            else:
                post_message(a.channel, a.text)
        else:
            sys.stderr.write("need --channel (with token) or --webhook\n")
            sys.exit(2)
    except urllib.error.URLError as e:
        sys.stderr.write("slack network error: %s\n" % e)
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
