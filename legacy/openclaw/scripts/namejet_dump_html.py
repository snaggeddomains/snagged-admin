#!/usr/bin/env python3
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

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

async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--disable-blink-features=AutomationControlled'])
        context = await browser.new_context(
            user_agent=USER_AGENT,
            locale='en-US',
            timezone_id='America/New_York',
            viewport={'width': 1366, 'height': 768},
        )
        await context.add_init_script(STEALTH_SCRIPT)
        page = await context.new_page()
        await page.goto('https://www.namejet.com/Pages/Default.aspx', wait_until='domcontentloaded', timeout=60000)
        try:
            await page.wait_for_function("document.title !== 'Just a moment...'", timeout=60000)
            await page.wait_for_load_state('networkidle', timeout=60000)
        except Exception:
            pass
        Path('namejet_page.html').write_text(await page.content())
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
