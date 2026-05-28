import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto("https://www.namejet.com/Pages/Default.aspx", wait_until="networkidle")
        await page.screenshot(path="namejet-login.png", full_page=True)
        html = await page.content()
        Path("namejet-login.html").write_text(html)
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
