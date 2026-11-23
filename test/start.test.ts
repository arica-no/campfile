import { expect, it } from 'vitest';
import { callApp } from './helpers.ts';

it("sends a browser's GET / to its pages, and gives anything that does not ask for HTML the instructions", async () => {
  const browser = await callApp('/', { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  expect(browser.status).toBe(302);
  expect(browser.headers.get('location')).toBe('/my');

  const agent = await callApp('/');
  expect(agent.status).toBe(200);
  expect(agent.headers.get('content-type')).toContain('text/plain');
  expect(await agent.text()).toBe(await (await callApp('/agents')).text());
});
