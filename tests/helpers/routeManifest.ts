import type { Role } from '../../src/constants/roles.js';

export interface ManifestRoute {
  method: 'get' | 'post';
  /** `:id` is replaced with a valid ObjectId by the RBAC test. */
  path: string;
  /** Minimum role. A viewer must get 403 on every ADMIN route (testing-strategy 2). */
  role: Role;
}

/** Grows each phase: every route that needs a role is listed here exactly once. */
export const ROUTE_MANIFEST: ManifestRoute[] = [
  { method: 'get', path: '/users', role: 'ADMIN' },
  { method: 'get', path: '/users/new', role: 'ADMIN' },
  { method: 'post', path: '/users/new', role: 'ADMIN' },
  { method: 'get', path: '/users/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/users/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/users/:id/delete', role: 'ADMIN' },
  { method: 'get', path: '/recipients', role: 'ADMIN' },
  { method: 'get', path: '/recipients/new', role: 'ADMIN' },
  { method: 'post', path: '/recipients/new', role: 'ADMIN' },
  { method: 'get', path: '/recipients/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/recipients/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/recipients/:id/delete', role: 'ADMIN' },
  { method: 'get', path: '/webhook-monitors/new', role: 'ADMIN' },
  { method: 'post', path: '/webhook-monitors/new', role: 'ADMIN' },
  { method: 'get', path: '/webhook-monitors/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/webhook-monitors/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/webhook-monitors/:id/delete', role: 'ADMIN' },
  { method: 'get', path: '/endpoint-monitors/new', role: 'ADMIN' },
  { method: 'post', path: '/endpoint-monitors/new', role: 'ADMIN' },
  { method: 'get', path: '/endpoint-monitors/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/endpoint-monitors/:id/edit', role: 'ADMIN' },
  { method: 'post', path: '/endpoint-monitors/:id/delete', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/alerts/:id/resend', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/webhook/:id/run', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/endpoint/:id/run', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/webhook/:id/pause', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/endpoint/:id/pause', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/webhook/:id/resume', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/endpoint/:id/resume', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/webhook/:id/test-email', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/monitors/endpoint/:id/test-email', role: 'ADMIN' },
  { method: 'get', path: '/api/v1/source/collections', role: 'ADMIN' },
  { method: 'post', path: '/api/v1/source/validate-timestamp-key', role: 'ADMIN' },
];
