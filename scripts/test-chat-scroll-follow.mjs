import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const source = ts.transpileModule(readFileSync(new URL("../lib/chat-scroll-follow.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, hasTouch: true });
    await page.setContent('<div id="chat" tabindex="0" style="height:300px;overflow:auto;overflow-anchor:none"><div id="content" style="height:2000px"><div id="nested" style="height:100px;overflow:auto;overscroll-behavior-y:contain"><div style="height:500px"></div></div><input /></div></div>');
    await page.addScriptTag({ content: `window.exports = {};\n${source}` });
    await page.evaluate(() => {
      const chat = document.querySelector('#chat');
      const content = document.querySelector('#content');
      window.following = true;
      window.dispose = window.exports.bindChatScrollFollow(chat, content, {
        interrupt: () => {},
        pause: () => { window.following = false; },
        resume: () => { window.following = true; },
        followResize: () => { if (window.following) chat.scrollTop = chat.scrollHeight; },
      });
      window.wheel = (deltaY, target = chat) => target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }));
    });
    await page.waitForTimeout(80);
    assert.equal(await page.$eval('#chat', el => el.scrollTop), 1700);
    await page.locator('#chat').hover();
    await page.mouse.wheel(0, -20);
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.following), false, 'small upward wheel escapes immediately');
    const pausedTop = await page.$eval('#chat', el => el.scrollTop);
    await page.$eval('#content', el => { el.style.height = '2400px'; });
    await page.waitForTimeout(80);
    assert.equal(await page.$eval('#chat', el => el.scrollTop), pausedTop, 'stream growth preserves reading position');
    await page.$eval('#content', el => { el.style.height = '1900px'; });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.following), false, 'collapse cannot resume');
    await page.evaluate(() => {
      const chat = document.querySelector('#chat');
      chat.scrollTop = 1500;
    });
    await page.waitForTimeout(40);
    await page.mouse.wheel(0, 90);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.following), true, `downward return resumes: ${await page.$eval('#chat', el => JSON.stringify({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }))}`);
    await page.locator('#chat').focus();
    await page.keyboard.press('PageUp');
    assert.equal(await page.evaluate(() => window.following), false, 'keyboard pauses');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.following = true;
      const chat = document.querySelector('#chat');
      const touch = y => new Touch({ identifier: 1, target: chat, clientY: y });
      chat.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], bubbles: true }));
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const chat = document.querySelector('#chat');
      chat.dispatchEvent(new TouchEvent('touchmove', { touches: [new Touch({ identifier: 1, target: chat, clientY: 120 })], bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.following), false, 'long touch gesture pauses');
    await page.evaluate(() => {
      window.following = true;
      window.wheel(-20, document.querySelector('#nested'));
    });
    assert.equal(await page.evaluate(() => window.following), true, 'nested scroll stays independent');
    await page.locator('input').focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => window.following), true, 'input keys stay independent');
    await page.evaluate(() => {
      window.following = false;
      const chat = document.querySelector('#chat');
      chat.scrollTop = chat.scrollHeight;
    });
    await page.waitForTimeout(40);
    await page.evaluate(() => window.wheel(20));
    assert.equal(await page.evaluate(() => window.following), true, 'downward input at bottom resumes without a scroll event');
    await page.$eval('#chat', el => { el.style.height = '240px'; });
    await page.waitForTimeout(80);
    assert.equal(await page.$eval('#chat', el => el.scrollHeight - el.scrollTop - el.clientHeight), 0, 'viewport resize follows');
    await page.evaluate(() => { window.dispose(); window.wheel(-20); });
    assert.equal(await page.evaluate(() => window.following), true, 'listeners cleaned up');
    await page.close();
  }
  console.log('chat scroll follow browser tests passed (desktop/mobile)');
} finally {
  await browser.close();
}
