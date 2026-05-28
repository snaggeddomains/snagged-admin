#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

WORKDIR = Path(__file__).resolve().parent.parent
CLOUDFLARE_ACCOUNT_ID = (WORKDIR / '.secrets' / 'cloudflare_account_id.txt').read_text().strip()
CLOUDFLARE_TOKEN = (WORKDIR / '.secrets' / 'cloudflare_browser_render_token.txt').read_text().strip()
TARGET_URL = 'https://www.namejet.com/store/basic.action'
OUTPUT_DIR = WORKDIR / 'data' / 'namejet'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

TRIGGER_SCRIPT = r"""
(() => {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const setStage = (value) => document.documentElement.setAttribute('data-namejet-stage', value);
  const markReady = (value) => document.documentElement.setAttribute('data-namejet-ready', value);
  const dispatchChange = (el) => el && el.dispatchEvent(new Event('change', { bubbles: true }));
  const setChecked = (selector, desired = true) => {
    document.querySelectorAll(selector).forEach(cb => {
      if (cb.checked !== desired) {
        cb.checked = desired;
        dispatchChange(cb);
      }
    });
  };
  const applyFilters = async () => {
    for (let i = 0; i < 200; i++) {
      const orderSelects = document.querySelectorAll('select#orderByDate');
      if (orderSelects.length) {
        orderSelects.forEach(sel => {
          if (sel.value !== '2') {
            sel.value = '2';
            dispatchChange(sel);
          }
        });
        document.querySelectorAll('select#searchType').forEach(sel => {
          if (sel.value !== 'contains') {
            sel.value = 'contains';
            dispatchChange(sel);
          }
        });
        setChecked('input[name="sourceType"][value=",2,3,"]', true);
        setChecked('input[name="sourceType"][value=",1,"]', true);
        setChecked('input[name="sourceType"][value=",4,5,6,"]', true);
        setChecked('input[name="listingType"][value="3"]', true);
        setChecked('input[name="listingType"][value="1"]', true);
        setChecked('input[name="listingType"][value="2"]', true);
        setChecked('input[name="bidorbuyinclude"]', true);
        setChecked('input[name="exclusions"][value="nohyphens"]', true);
        setChecked('input[name="exclusions"][value="nonum"]', true);
        setChecked('input[name="exclusions"][value="noidn"]', true);
        return true;
      }
      await sleep(250);
    }
    throw new Error('Filters not ready');
  };
  const buildSearchBody = () => {
    if (typeof window.getSearchCriteria !== 'function') {
      return '';
    }
    return window.getSearchCriteria();
  };
  const fetchPage = async (baseBody, startIndex, pageSize, token) => {
    const endIndex = startIndex + pageSize - 1;
    const body = baseBody + '&startIndex=' + startIndex + '&endIndex=' + endIndex + '&itemsPerPage=' + pageSize;
    const resp = await fetch('https://www.namejet.com/store/search.action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'sess-token': token,
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
      body,
    });
    if (!resp.ok) {
      throw new Error('search.action failed ' + resp.status);
    }
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON from search.action');
    }
  };
  const run = async () => {
    try {
      await applyFilters();
      setStage('filters');
      const ajaxToken = window.ajaxToken;
      if (!ajaxToken) {
        throw new Error('Missing ajaxToken');
      }
      const storeFrontName = window.storeFrontName || 'domainerPlus';
      const pageSize = 500;
      const searchBody = buildSearchBody();
      const baseBody = searchBody + '&searchResultKey=11&storeName=' + encodeURIComponent(storeFrontName) + '&initialOnloadValue=false';
      const first = await fetchPage(baseBody, 1, pageSize, ajaxToken);
      const total = Number(first.RecordsTotal || first.recordsTotal || first.recordsFiltered || (Array.isArray(first.data) ? first.data.length : 0)) || 0;
      const rows = Array.isArray(first.data) ? [...first.data] : [];
      let nextIndex = pageSize + 1;
      while (nextIndex <= total) {
        const page = await fetchPage(baseBody, nextIndex, pageSize, ajaxToken);
        if (Array.isArray(page.data)) {
          rows.push(...page.data);
        }
        nextIndex += pageSize;
        setStage('page-' + Math.min(nextIndex - 1, total));
      }
      const payload = { total, rows };
      const holder = document.getElementById('namejet-data') || document.createElement('pre');
      holder.id = 'namejet-data';
      holder.style.display = 'none';
      holder.textContent = JSON.stringify(payload);
      (document.body || document.documentElement).appendChild(holder);
      markReady('1');
    } catch (err) {
      setStage('error');
      markReady('error');
    }
  };
  run();
})();
"""

payload = {
    'url': TARGET_URL,
    'gotoOptions': {'waitUntil': 'domcontentloaded'},
    'waitForSelector': {'selector': '[data-namejet-ready="1"]', 'timeout': 120000},
    'addScriptTag': [
        {'content': TRIGGER_SCRIPT},
    ],
    'waitForTimeout': 5000,
    'bestAttempt': True,
}

api_url = f'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/browser-rendering/content?cacheTTL=0'
headers = {
    'Authorization': f'Bearer {CLOUDFLARE_TOKEN}',
    'Content-Type': 'application/json',
}

probe_payload = {
    'url': TARGET_URL,
    'gotoOptions': {'waitUntil': 'domcontentloaded'},
    'waitForTimeout': 5000,
    'bestAttempt': True,
}
probe = requests.post(api_url, headers=headers, data=json.dumps(probe_payload), timeout=90)
if probe.ok:
    probe_body = probe.json()
    probe_html = probe_body.get('result', '')
    if 'Just a moment...' in probe_html and 'challenges.cloudflare.com' in probe_html:
        challenge_path = OUTPUT_DIR / 'namejet_exclusive_challenge.html'
        challenge_path.write_text(probe_html)
        raise RuntimeError(f'NameJet returned a Cloudflare challenge page; saved debug HTML to {challenge_path}')

resp = requests.post(api_url, headers=headers, data=json.dumps(payload), timeout=180)
if resp.status_code >= 400:
    print('Cloudflare response:', resp.text[:1000])
    resp.raise_for_status()
body = resp.json()
if not body.get('success'):
    raise RuntimeError(f'Cloudflare rendering failed: {body}')
html = body['result']
raw_path = OUTPUT_DIR / 'namejet_exclusive_raw.html'
raw_path.write_text(html)
if 'Just a moment...' in html and 'challenges.cloudflare.com' in html:
    challenge_path = OUTPUT_DIR / 'namejet_exclusive_challenge.html'
    challenge_path.write_text(html)
    raise RuntimeError(f'NameJet returned a Cloudflare challenge page; saved debug HTML to {challenge_path}')

soup = BeautifulSoup(html, 'lxml')
headers = []
rows_data = []
meta = {}
data_script = soup.select_one('#namejet-data')
if data_script and data_script.text.strip():
    try:
        payload_data = json.loads(data_script.text)
        headers = payload_data.get('headers') or []
        rows_data = payload_data.get('rows') or []
        meta = {k: payload_data.get(k) for k in ('total', 'searchCriteria') if payload_data.get(k) is not None}
    except json.JSONDecodeError:
        rows_data = []
if not rows_data:
    table = soup.select_one('#searchTable')
    if not table:
        raise RuntimeError('Could not locate #searchTable in rendered HTML')
    headers = [th.get_text(strip=True) for th in table.select('thead th')]
    rows_data = []
    for tr in table.select('tbody tr'):
        cells = [td.get_text(strip=True).replace('\xa0', ' ') for td in tr.find_all('td')]
        if cells:
            rows_data.append(cells)
if not rows_data:
    stage = soup.select_one('[data-namejet-stage]')
    stage_value = stage['data-namejet-stage'] if stage else 'unknown'
    raise RuntimeError(f'No NameJet exclusive rows captured (stage={stage_value})')

timestamp = datetime.now(timezone.utc)
latest_path = OUTPUT_DIR / 'namejet_exclusive_latest.json'
latest_path.write_text(json.dumps({'fetched_at': timestamp.isoformat(), 'headers': headers, 'rows': rows_data, 'meta': meta}, indent=2))
print(f'Wrote {latest_path} with {len(rows_data)} rows')
