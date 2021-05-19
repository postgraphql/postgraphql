jest.unmock('postgraphile-core');

import pgPool, { poolConfig } from '../../__tests__/utils/pgPool';
import { postgraphile } from '..';

const COMMON_OPTIONS = {
  exitOnFail: false,
};

test('When the handler is created using a Pool object, it can be released without triggering an error', async () => {
  let handler = postgraphile(pgPool, COMMON_OPTIONS);
  await handler.release();
});

test('When the handler is created using Pool config, it releases the pool it creates', async () => {
  let handler = postgraphile(poolConfig, COMMON_OPTIONS);
  let { pgPool } = handler;
  expect(pgPool).toHaveProperty('ended', false);
  await handler.release();
  expect(pgPool).toHaveProperty('ended', true);
});
