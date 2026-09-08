#!/usr/bin/env python3
"""Telegram -> Claude bot.

A standalone bot contact (created via @BotFather) that relays every message
into a persistent headless Claude session and sends the reply back.

Auth: locks to the first Telegram user id that messages it (stored in state);
everyone else gets refused. Delete owner_id from state to re-lock.

Token: ~/.claude/tg-bot/token (one line, from @BotFather).
State: ~/.claude/tg-bot/state.json   Log: ~/.claude/tg-bot/bot.log
Run:   tg-bot.py [--once]
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HOME = os.path.expanduser('~')
DIR = f'{HOME}/.claude/tg-bot'
STATE = f'{DIR}/state.json'
LOG = f'{DIR}/bot.log'
CLAUDE = f'{HOME}/.claude/local/claude'
BOT_DIR = f'{HOME}/repo/cc-orchestrator/tg-bot/bot-home'
BOT_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch'
POLL_TIMEOUT = 50  # telegram long-poll seconds


def log(msg):
    line = f'{time.strftime("%Y-%m-%dT%H:%M:%S%z")} {msg}'
    with open(LOG, 'a') as f:
        f.write(line + '\n')
    print(line, flush=True)


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def save_state(st):
    json.dump(st, open(STATE, 'w'))


def token():
    return open(f'{DIR}/token').read().strip()


def api(method, **params):
    url = f'https://api.telegram.org/bot{token()}/{method}'
    data = urllib.parse.urlencode(params).encode()
    with urllib.request.urlopen(url, data, timeout=POLL_TIMEOUT + 10) as r:
        return json.load(r)


def send(chat_id, text):
    # telegram hard limit 4096 chars/message
    for i in range(0, len(text), 4000):
        api('sendMessage', chat_id=chat_id, text=text[i:i + 4000])


def ask_claude(text, st):
    cmd = [CLAUDE, '-p', text, '--output-format', 'json', '--allowedTools', BOT_TOOLS]
    if st.get('sid'):
        cmd += ['--resume', st['sid']]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900, cwd=BOT_DIR)
    if r.returncode != 0:
        log(f'claude failed exit={r.returncode} err={r.stderr[-200:]!r}')
        return '(bot error - could not process that; see bot.log)'
    try:
        out = json.loads(r.stdout)
        st['sid'] = out.get('session_id', st.get('sid'))
        return out.get('result') or '(empty reply)'
    except Exception:
        return r.stdout[-1500:]


def handle(update, st):
    msg = update.get('message') or {}
    chat_id = (msg.get('chat') or {}).get('id')
    text = msg.get('text') or ''
    if not chat_id or not text:
        return
    if 'owner_id' not in st:
        st['owner_id'] = chat_id
        log(f'locked to owner chat_id={chat_id}')
        send(chat_id, 'Locked to you. This bot answers only this chat now.')
    if chat_id != st['owner_id']:
        log(f'refused chat_id={chat_id}: {text[:80]!r}')
        send(chat_id, 'Not authorized.')
        return
    if text == '/new':
        st.pop('sid', None)
        send(chat_id, 'Fresh session started.')
        return
    log(f'inbound {chat_id}: {text[:120]!r}')
    send(chat_id, ask_claude(text, st))


def run_once(st):
    resp = api('getUpdates', offset=st.get('offset', 0), timeout=POLL_TIMEOUT)
    for u in resp.get('result', []):
        st['offset'] = u['update_id'] + 1
        try:
            handle(u, st)
        except Exception as e:
            log(f'handle ERROR {type(e).__name__}: {e}')
        save_state(st)
    return len(resp.get('result', []))


def main():
    os.makedirs(DIR, exist_ok=True)
    st = load_state()
    if '--once' in sys.argv:
        log(f'once: handled {run_once(st)} update(s)')
        return
    log('tg-bot starting (long-poll)')
    while True:
        try:
            run_once(st)
        except Exception as e:
            log(f'ERROR {type(e).__name__}: {e}')
            time.sleep(10)


if __name__ == '__main__':
    main()
