/**
 * Helpers for driving the dedicated Chrome over CDP.
 *   pnpm --filter @sideby/chrome-tools exec tsx drive.ts <command> [args]
 * Commands:
 *   tabs                         list open pages
 *   open <url>                   open a new tab
 *   goto <index> <url>           navigate an existing tab
 *   shot <index> <file.png>      screenshot a tab
 *   eval <index> <js>            evaluate JS in the page (MAIN world)
 *   debug <index>                read the Sideby debug panel values
 *   ext                          list extension service workers
 */
import { chromium, type Page } from 'playwright-core';

const PORT = process.env.SIDEBY_CDP_PORT ?? '9222';

async function connect() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('no browser context; is Chrome running via launch.sh?');
  return { browser, context };
}

function pageAt(pages: Page[], idx: string | undefined): Page {
  const p = pages[Number(idx ?? 0)];
  if (!p) throw new Error(`no tab at index ${idx}`);
  return p;
}

/** Reads the values rendered in the overlay's debug panel (inside the shadow root). */
export async function readDebugPanel(page: Page) {
  return page.evaluate(() => {
    const host = document.getElementById('sideby-host');
    const root = host?.shadowRoot;
    if (!root) return { mounted: false };
    const pill = root.querySelector('.sb-pill')?.textContent ?? null;
    const kv: Record<string, string> = {};
    root.querySelectorAll('.sb-kv').forEach((dl) => {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      dts.forEach((dt, i) => { kv[dt.textContent ?? ''] = dds[i]?.textContent ?? ''; });
    });
    const log = Array.from(root.querySelectorAll('.sb-log div')).map((d) => d.textContent);
    return { mounted: true, pill, panelOpen: !!root.querySelector('.sb-panel'), kv, log };
  });
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const { browser, context } = await connect();
  const pages = context.pages();
  try {
    switch (cmd) {
      case 'tabs':
        pages.forEach((p, i) => console.log(i, p.url()));
        break;
      case 'open': {
        const p = await context.newPage();
        await p.goto(a!, { waitUntil: 'domcontentloaded' });
        console.log('opened', p.url());
        break;
      }
      case 'goto':
        await pageAt(pages, a).goto(b!, { waitUntil: 'domcontentloaded' });
        console.log('navigated');
        break;
      case 'shot':
        await pageAt(pages, a).screenshot({ path: b ?? 'shot.png' });
        console.log('saved', b ?? 'shot.png');
        break;
      case 'eval':
        console.log(JSON.stringify(await pageAt(pages, a).evaluate(b!), null, 2));
        break;
      case 'debug':
        console.log(JSON.stringify(await readDebugPanel(pageAt(pages, a)), null, 2));
        break;
      case 'ext':
        for (const w of context.serviceWorkers()) console.log(w.url());
        break;
      default:
        console.log('commands: tabs | open <url> | goto <i> <url> | shot <i> <file> | eval <i> <js> | debug <i> | ext');
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith('drive.ts')) main().catch((err) => { console.error(err); process.exit(1); });
