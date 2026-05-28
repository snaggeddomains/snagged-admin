#!/usr/bin/env python3
import argparse
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright

OXYLABS_CONF = Path('.secrets/oxylabs_web_unblocker.txt')
NAMEJET_CONF = Path('.secrets/namejet.txt')
USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/122.0.0.0 Safari/537.36'
)

STEALTH_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = { runtime: {} };
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
"""


def load_oxylabs_creds() -> dict:
    data = {}
    for line in OXYLABS_CONF.read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            data[k.strip()] = v.strip()
    return data


def load_namejet_creds() -> dict:
    data = {}
    for line in NAMEJET_CONF.read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            data[k.strip()] = v.strip()
    return data


async def main() -> None:
    parser = argparse.ArgumentParser(description='NameJet most-active fetcher')
    parser.add_argument('--proxy', choices=['oxylabs', 'oxylabs-render', 'none'], default='oxylabs')
    parser.add_argument('--report-file', default='oxylabs_failure_report.json', help='Write Oxylabs diagnostics to this JSON file')
    args = parser.parse_args()
    print(f"Using proxy mode: {args.proxy}", flush=True)
    proxy = None
    oxylabs_headers = {}
    if args.proxy in {'oxylabs', 'oxylabs-render'}:
        proxy_creds = load_oxylabs_creds()
        endpoint = proxy_creds.get('ENDPOINT', 'https://unblock.oxylabs.io:60000')
        proxy = {
            'server': endpoint,
            'username': proxy_creds['USERNAME'],
            'password': proxy_creds['PASSWORD'],
        }
        if args.proxy == 'oxylabs-render':
            oxylabs_headers['x-oxylabs-render'] = 'html'
    nj_creds = load_namejet_creds()
    async with async_playwright() as p:
        launch_kwargs = {'headless': True}
        if proxy:
            launch_kwargs['proxy'] = proxy
        browser = await p.chromium.launch(**launch_kwargs)
        context_kwargs = dict(
            user_agent=USER_AGENT,
            locale='en-US',
            timezone_id='America/New_York',
            viewport={'width': 1366, 'height': 768},
            ignore_https_errors=True,
        )
        if oxylabs_headers:
            context_kwargs['extra_http_headers'] = oxylabs_headers
        context = await browser.new_context(**context_kwargs)
        await context.add_init_script(STEALTH_SCRIPT)
        await context.add_init_script(
            """
            window.currentSearchSpec = window.currentSearchSpec || {
                searchTerm: '',
                searchType: 'contains',
                category: [],
                orderByDate: null,
                specialEvent: null,
                tlds: ['.com', '.net', '.org'],
                sources: [],
                listingType: [],
                maxPrice: '',
                maxCharacters: '',
                maxWords: '',
                isHyphenAllowed: true,
                isNumberAllowed: true,
                isIdnAllowed: true,
                isAllNumbers: false,
                nslist: [],
                minAge: '',
                maxAge: '',
                minViews: '',
                maxViews: '',
                minRev: '',
                maxRev: '',
                bidorbuyinclude: false,
            };
            window.isInitialOnloadValue = typeof window.isInitialOnloadValue === 'undefined' ? true : window.isInitialOnloadValue;
            """
        )
        page = await context.new_page()
        page.on('console', lambda msg: print(f"[console:{msg.type}] {msg.text}", flush=True))
        page.on('pageerror', lambda exc: print(f"[pageerror] {exc}", flush=True))
        login_url = 'https://www.namejet.com/login.sn?sendBack=%2Fstore%2Fdomainer.action%3Fig%253D504'
        target_url = 'https://www.namejet.com/store/domainer.action?ig=504'
        print(f"Navigating to login page {login_url}", flush=True)
        await page.goto(login_url, wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_selector('input[name="loginUsername"]', timeout=60000)
        username = page.locator('form[name="loginForm"] input[name="loginUsername"]')
        password = page.locator('form[name="loginForm"] input[name="loginPassword"]')
        await username.wait_for(state='visible', timeout=60000)
        await password.wait_for(state='visible', timeout=60000)
        await username.click()
        await username.fill('')
        await username.type(nj_creds['USERNAME'], delay=50)
        typed_username = await username.input_value()
        print(f"Username characters entered: {len(typed_username)}", flush=True)
        await password.click()
        await password.fill('')
        await password.type(nj_creds['PASSWORD'], delay=50)
        typed_password = await password.input_value()
        print(f"Password characters entered: {len(typed_password)}", flush=True)
        await page.screenshot(path='namejet_login_page.png', full_page=True)
        login_request_future = page.wait_for_event(
            'request',
            lambda req: '/login.do' in req.url and req.method == 'POST',
            timeout=60000,
        )
        login_response_future = page.wait_for_event(
            'response',
            lambda resp: '/login.do' in resp.url,
            timeout=60000,
        )
        await page.eval_on_selector('form[name="loginForm"]', 'form => form.submit()')
        try:
            login_request = await login_request_future
            print(f"Login POST payload: {login_request.post_data}", flush=True)
        except Exception:
            print('Login POST did not fire.', flush=True)
        try:
            login_response = await login_response_future
            print(f"Login response status: {login_response.status}", flush=True)
        except Exception:
            print('Login response not observed.', flush=True)
        await page.wait_for_load_state('load')
        try:
            await page.goto(target_url, wait_until='domcontentloaded', timeout=120000)
        except Exception:
            Path('namejet_login_failure.html').write_text(await page.content())
            await page.screenshot(path='namejet_login_failure.png', full_page=True)
            raise
        print(f"Navigated to {target_url}", flush=True)
        print('Initial navigation complete; waiting for scripts to render table...', flush=True)
        await page.wait_for_timeout(15000)
        print('Waiting for #searchTable to be present...', flush=True)
        await page.wait_for_selector('#searchTable', state='attached', timeout=60000)
        print('Waiting for search payload...', flush=True)
        async def wait_for_search_result(expected_key: int):
            while True:
                response = await page.wait_for_event(
                    'response',
                    lambda resp: '/store/search.action' in resp.url,
                    timeout=60000,
                )
                request = response.request
                post_data = request.post_data or ''
                print(f"Observed search.action (status={response.status}) payload: {post_data}", flush=True)
                if f'searchResultKey={expected_key}' in post_data:
                    return response, request, post_data
        search_response, search_request, request_body = await wait_for_search_result(11)
        Path('namejet_search_request.txt').write_text(request_body)
        Path('namejet_search_request_headers.json').write_text(
            json.dumps(search_request.headers, indent=2)
        )
        response_headers = await search_response.all_headers()
        Path('namejet_search_response_headers.json').write_text(
            json.dumps(response_headers, indent=2)
        )
        print('Captured request payload.', flush=True)
        print(f"Captured response status: {search_response.status}", flush=True)
        error_header = search_response.headers.get('errorMessage') if hasattr(search_response, 'headers') else None
        if error_header:
            print(f"Response error header: {error_header}", flush=True)
        search_json = await search_response.text()
        Path('namejet_search.json').write_text(search_json)
        print(f"Captured /store/search.action payload ({len(search_json)} bytes).", flush=True)
        print('Waiting for table rows to render...', flush=True)
        await page.wait_for_function(
            "document.querySelector('#searchTable tbody tr') || document.querySelector(\"#searchTable tr[role='row']\")",
            timeout=60000,
        )
        print('Saving page and table snapshots...', flush=True)
        Path('namejet_most_active.html').write_text(await page.content())
        table_html = await page.inner_html('#searchTable')
        Path('namejet_table.html').write_text(table_html)
        rows = await page.eval_on_selector_all(
            '#searchTable tbody tr',
            "rows => rows.map(row => Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()))",
        )
        Path('namejet_rows.json').write_text(json.dumps(rows, indent=2))
        ajax_token = await page.evaluate("() => window.ajaxToken || ''")
        Path('namejet_ajax_token.txt').write_text(ajax_token or '')
        cookies = await context.cookies()
        Path('namejet_cookies.json').write_text(json.dumps(cookies, indent=2))
        if request_body:
            manual_headers = {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'sess-token': ajax_token or '',
                'X-Requested-With': 'XMLHttpRequest',
            }
            if oxylabs_headers:
                manual_headers.update(oxylabs_headers)
            print('Replaying search.action manually via context.request.post ...', flush=True)
            manual_response = await context.request.post(
                'https://www.namejet.com/store/search.action',
                data=request_body,
                headers=manual_headers,
            )
            manual_status = manual_response.status
            manual_body = await manual_response.text()
            Path('namejet_manual_search_status.txt').write_text(str(manual_status))
            Path('namejet_manual_search_response.json').write_text(manual_body)
            manual_resp_headers = manual_response.headers
            Path('namejet_manual_search_response_headers.json').write_text(
                json.dumps(manual_resp_headers, indent=2)
            )
            print(f"Manual search response status: {manual_status}", flush=True)
            report = {
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'proxy_mode': args.proxy,
                'ajax_token': ajax_token,
                'search_request_body': request_body,
                'search_response_status': search_response.status,
                'search_response_headers': response_headers,
                'manual_response_status': manual_status,
                'manual_response_headers': manual_resp_headers,
            }
            Path(args.report_file).write_text(json.dumps(report, indent=2))
        await browser.close()
        print('Done.')


if __name__ == '__main__':
    asyncio.run(main())
