import { jest } from '@jest/globals';

// Starting and stopping a real mongod can take several seconds when many suites run in parallel.
// Jest applies this to tests AND hooks (a project-level `testTimeout` option is not honoured).
jest.setTimeout(120_000);
