#!/usr/bin/env python3
import asyncio
import urllib.parse

from playwright.async_api import async_playwright

OXYLABS_CONF = '.secrets/oxylabs_web_unblocker.txt'
NAMEJET_CONF = '.secrets/namejet.txt'


def load_kv(path):
    data = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            if '=' in line:
                k, v = line.strip().split('=', 1)
                data[k.strip()] = v.strip()
    return data


async def main():
    proxy_creds = load_kv(OXYLABS_CONF)
    nj_creds = load_kv(NAMEJET_CONF)
    endpoint = proxy_creds.get('ENDPOINT', 'https://unblock.oxylabs.io:60000')
    proxy = {
        'server': endpoint,
        'username': proxy_creds['USERNAME'],
        'password': proxy_creds['PASSWORD'],
    }
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, proxy=proxy)
        context = await browser.new_context(
            user_agent=(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/122.0.0.0 Safari/537.36'
            ),
            ignore_https_errors=True,
        )
        page = await context.new_page()
        login_url = 'https://www.namejet.com/login.sn?sendBack=%2Fstore%2Fexclusivestorefront.action%3Fsid%3D1773684433339'
        await page.goto(login_url, wait_until='domcontentloaded')
        await page.fill('form[name="loginForm"] input[name="loginUsername"]', nj_creds['USERNAME'])
        await page.fill('form[name="loginForm"] input[name="loginPassword"]', nj_creds['PASSWORD'])
        await page.eval_on_selector('form[name="loginForm"]', 'form => form.submit()')
        await page.wait_for_load_state('load')
        target_url = 'https://www.namejet.com/store/exclusivestorefront.action?sid=1773684433339'
        await page.goto(target_url, wait_until='domcontentloaded')
        ajax_token = await page.evaluate('window.ajaxToken')
        if not ajax_token:
            raise RuntimeError('ajaxToken not found')
        payload = {
            'searchTerm': '',
            'searchType': 'contains',
            'category': '',
            'orderByDate': '',
            'event': '',
            'tld': '.org,.com,.net',
            'sourceType': '1',
            'listingType': '1,2',
            'exclusions': '',
            'nsList': '',
            'bidorbuyinclude': '0',
            'searchResultKey': '11',
            'storeName': 'exclusiveAll',
            'isInitial': 'true',
            'itemsPerPage': '25',
        }
        response = await context.request.post(
            'https://www.namejet.com/store/search.action',
            data=payload,
            headers={
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'sess-token': ajax_token,
                'x-requested-with': 'XMLHttpRequest',
                'origin': 'https://www.namejet.com',
                'referer': target_url,
            },
        )
        print('Status:', response.status)
        print('Headers:', response.headers)
        text = await response.text()
        print('Body snippet:', text[:500])
        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
