/**
 * Prebuild the public pages.
 *
 * The landing page, the sign-in page and the sign-up page are written into
 * the build output as static HTML, so the browser can paint them without
 * waiting for the JavaScript bundle to arrive. The client then hydrates that
 * markup instead of rendering it a second time.
 *
 * This runs after `vite build`, reads the built shell, and writes one file
 * per public route. It never fails the build: if a page cannot be rendered
 * here, it keeps the plain shell and the app renders it in the browser as
 * before.
 *
 * usage: pnpm exec tsx scripts/node/prerender.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Route, Routes, StaticRouter } from 'react-router-dom';
// The constants Vite writes into the bundle have to be in place before the
// pages read them, and imports are evaluated in the order they are written.
import './set-build-constants';
import { LandingPage } from '../../src/pages/landing/LandingPage';
import { Login } from '../../src/pages/auth/Login';
import { Register } from '../../src/pages/auth/Register';

const DIST = resolve(process.cwd(), 'dist');
const SHELL = resolve(DIST, 'index.html');

/** The routes that are prebuilt, and the file each one is written to. */
const PAGES: { route: string; file: string; element: ReactElement }[] = [
  { route: '/', file: 'index.html', element: createElement(LandingPage) },
  { route: '/login', file: 'login.html', element: createElement(Login) },
  { route: '/register', file: 'register.html', element: createElement(Register) },
];

/** The empty root element the build leaves behind. */
const ROOT_PATTERN = /<div id="root"><\/div>/;

/**
 * The example scan the landing page is built with. The client reads it back
 * from the markup, so the hydrated page shows the same one the browser was
 * given.
 */
const DEMO_INDEX = '0';

function renderPage(shell: string, route: string, element: ReactElement): string | null {
  let markup: string;

  try {
    markup = renderToString(
      createElement(
        StaticRouter,
        { location: route },
        createElement(
          Routes,
          null,
          createElement(Route, { path: route, element }),
        ),
      ),
    );
  } catch (error) {
    console.warn(`[prerender] ${route} could not be rendered: ${(error as Error).message}`);
    return null;
  }

  const root = `<div id="root" data-prerendered="true" data-demo-index="${DEMO_INDEX}">${markup}</div>`;
  return shell.replace(ROOT_PATTERN, root);
}

function main(): void {
  const shell = readFileSync(SHELL, 'utf-8');

  if (!ROOT_PATTERN.test(shell)) {
    console.warn('[prerender] the built shell has no empty root element; nothing to prebuild');
    return;
  }

  let written = 0;

  for (const page of PAGES) {
    const html = renderPage(shell, page.route, page.element);
    if (!html) continue;
    writeFileSync(resolve(DIST, page.file), html, 'utf-8');
    written += 1;
  }

  if (written > 0) {
    console.log(
      `[prerender] ${written} public page(s) prebuilt: ${PAGES.map((page) => page.file).join(', ')}`,
    );
  }
}

main();
