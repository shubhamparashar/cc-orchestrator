#!/usr/bin/env python3
"""WhatsApp -> Claude session relay.

Polls the alerts-bridge message store for new inbound messages on Shubham's
own-number chat and routes each one into the Claude Code session it belongs
to, via headless resume (`claude -p --resume <sid>`), which persists the turn
into that session.

Routing:
  1. explicit override: message starts with `sid <8-hex>` (or `[sid:...]`)
  2. otherwise: BOT (read-only) - no recency fallback into a work session

The bridge store does NOT record WhatsApp quote/reply metadata, so a work
session is only reachable by explicit tag, never by guessing the most recent
one.

State: ~/.claude/wa-watch/relay-state.json  (last handled message timestamp+ids)
Log:   ~/.claude/wa-watch/relay.log
Run:   wa-relay.py [--once] [--dry-run]
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser('~')
DB = f'{HOME}/repo/whatsapp-mcp/whatsapp-bridge-alerts/store/messages.db'
CHAT_JID = '211772053135607@lid'
WATCH_DIR = f'{HOME}/.claude/wa-watch'
STATE = f'{WATCH_DIR}/relay-state.json'
REGISTRY = f'{WATCH_DIR}/sid-registry.jsonl'
LOG = f'{WATCH_DIR}/relay.log'
CLAUDE = f'{HOME}/.claude/local/claude'
POLL_SECONDS = 30
SID_RE = re.compile(r'^\s*\[?sid[:\s]+([0-9a-f]{8})', re.I)
BOT_DIR = f'{HOME}/repo/cc-orchestrator/wa-relay/bot-home'
BOT_STATE = f'{WATCH_DIR}/bot-session.json'
BOT_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch'


def log(msg):
    line = f'{time.strftime("%Y-%m-%dT%H:%M:%S%z")} {msg}'
    with open(LOG, 'a') as f:
        f.write(line + '\n')
    print(line, flush=True)


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {'last_ts': time.strftime('%Y-%m-%d %H:%M:%S+00:00'), 'seen_ids': []}


def save_state(st):
    st['seen_ids'] = st['seen_ids'][-200:]
    json.dump(st, open(STATE, 'w'))


def registry_entries():
    out = []
    try:
        for line in open(REGISTRY):
            line = line.strip()
            if line:
                out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out


def entry_for_sid(sid):
    for e in reversed(registry_entries()):
        if e['sid'] == sid:
            return e
    return {}


def registered_tags(entries):
    seen = []
    for e in entries:
        if e['tag'] not in seen:
            seen.append(e['tag'])
    return seen


def tag_hint(entries):
    tags = registered_tags(entries)
    if not tags:
        return 'No work sessions registered. Reply "sid <tag>" once one exists.'
    return f'Untagged/unknown - reply "sid <tag>" to reach a session. Registered tags: {", ".join(tags)}'


def resolve_sid(text):
    m = SID_RE.match(text)
    entries = registry_entries()
    if m:
        tag = m.group(1)
        for e in reversed(entries):
            if e['tag'] == tag or e['sid'].startswith(tag):
                return e['sid'], f'explicit tag {tag}', None
        return 'BOT', f'explicit tag {tag} not in registry', tag_hint(entries)
    return 'BOT', 'no tag - default bot route', tag_hint(entries)


def wa_send(text):
    body = json.dumps({'recipient': '918700445124@s.whatsapp.net', 'message': text})
    r = subprocess.run(['curl', '-s', '-m', '15', '-X', 'POST', 'localhost:8081/api/send',
                        '-H', 'Content-Type: application/json', '-d', body],
                       capture_output=True, text=True)
    ok = '"success":true' in r.stdout.replace(' ', '')
    log(f'wa_send ok={ok} resp={r.stdout[:120]!r}')
    return ok


def deliver_bot(text, dry):
    if dry:
        log('DRY-RUN would invoke bot session')
        return True
    try:
        bot = json.load(open(BOT_STATE))
    except Exception:
        bot = {}
    cmd = [CLAUDE, '-p', text, '--output-format', 'json', '--allowedTools', BOT_TOOLS]
    if bot.get('sid'):
        cmd += ['--resume', bot['sid']]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900, cwd=BOT_DIR)
    if r.returncode != 0:
        log(f'bot invoke failed exit={r.returncode} err={r.stderr[-200:]!r}')
        wa_send('(bot error - could not process that message; see relay.log)')
        return False
    try:
        out = json.loads(r.stdout)
        json.dump({'sid': out.get('session_id', bot.get('sid'))}, open(BOT_STATE, 'w'))
        reply = out.get('result') or '(empty bot reply)'
    except Exception:
        reply = r.stdout[-1500:]
    return wa_send(reply[:3500])


def new_messages(st):
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    rows = con.execute(
        "SELECT id, datetime(timestamp) ts, content FROM messages "
        "WHERE chat_jid=? AND is_from_me=0 AND content != '' "
        "AND datetime(timestamp) > datetime(?) ORDER BY timestamp",
        (CHAT_JID, st['last_ts'])).fetchall()
    con.close()
    return [r for r in rows if r[0] not in st['seen_ids']]


def deliver(sid, text, dry):
    prompt = (f'WhatsApp reply from Shubham (relayed by wa-relay): {text}\n\n'
              'Treat this as a normal user instruction/question for this session. '
              'If it needs an answer, reply to his WhatsApp per the '
              'whatsapp-update-watch skill (port 8081 bridge) as well as in the session.')
    if dry:
        log(f'DRY-RUN would run: claude --resume {sid} -p <{len(prompt)}B prompt>')
        return True
    cwd = entry_for_sid(sid).get('cwd') or f'{HOME}/repo/fleek-api'
    r = subprocess.run(
        [CLAUDE, '--resume', sid, '-p', prompt, '--permission-mode', 'acceptEdits'],
        capture_output=True, text=True, timeout=1800, cwd=cwd)
    log(f'claude --resume {sid[:8]} cwd={cwd} exit={r.returncode} '
        f'out={r.stdout[-200:]!r} err={r.stderr[-200:]!r}')
    return r.returncode == 0


def run_once(dry=False):
    st = load_state()
    msgs = new_messages(st)
    for mid, ts, content in msgs:
        sid, how, hint = resolve_sid(content)
        log(f'inbound {mid} @{ts}: {content[:120]!r} -> sid={sid and sid[:8]} ({how})')
        if sid == 'BOT':
            if hint:
                if dry:
                    log(f'DRY-RUN would send hint: {hint!r}')
                else:
                    wa_send(hint)
            deliver_bot(content, dry)
        elif sid:
            deliver(sid, content, dry)
        st['seen_ids'].append(mid)
        st['last_ts'] = ts
    if msgs:
        save_state(st)
    return len(msgs)


def main():
    os.makedirs(WATCH_DIR, exist_ok=True)
    dry = '--dry-run' in sys.argv
    if '--once' in sys.argv:
        n = run_once(dry)
        log(f'once: handled {n} message(s)')
        return
    log('wa-relay starting (poll %ss)' % POLL_SECONDS)
    while True:
        try:
            run_once(dry)
        except Exception as e:
            log(f'ERROR {type(e).__name__}: {e}')
        time.sleep(POLL_SECONDS)


if __name__ == '__main__':
    main()
