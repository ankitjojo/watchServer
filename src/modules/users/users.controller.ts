import type { RequestHandler, Response } from 'express';
import { AppError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import type { AuthUser } from '../../types/express.js';
import { setFlash } from '../../utils/flash.js';
import { renderPage } from '../../utils/renderPage.js';
import type { UsersService } from './users.service.js';
import { createUserValidation, idValidation, updateUserValidation } from './users.schemas.js';
import {
  USER_DELETED_COLUMNS,
  USER_ROLE_OPTIONS,
  toUserDeletedRow,
  toUserFormValues,
  toUserRowView,
} from './users.view.js';

export interface UsersController {
  list: RequestHandler;
  newForm: RequestHandler;
  create: RequestHandler;
  editForm: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

/** Entered values for re-rendering a form: the password is never sent back to the browser. */
function withoutPassword(body: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'password'));
}

function actorOf(user: AuthUser | undefined): { id: string; email: string } {
  // requireRole ran before this controller, so a user is always present.
  if (!user) throw new Error('authenticated user missing');
  return { id: user.id, email: user.email };
}

export function createUsersController(deps: { users: UsersService; timeZone: string }): UsersController {
  const { users, timeZone } = deps;

  function renderForm(
    res: Response,
    model: {
      mode: 'create' | 'edit';
      id?: string;
      values: Record<string, unknown>;
      errors: Record<string, string>;
    },
    status = 200,
  ): Promise<void> {
    return renderPage(
      res,
      'pages/users/form',
      {
        pageTitle: model.mode === 'create' ? 'New user' : 'Edit user',
        roles: USER_ROLE_OPTIONS,
        id: model.id,
        ...model,
      },
      status,
    );
  }

  function conflictErrors(err: AppError): Record<string, string> {
    const details = err.details;
    const field =
      typeof details === 'object' &&
      details !== null &&
      'field' in details &&
      typeof details.field === 'string'
        ? details.field
        : '_form';
    return { [field]: err.message };
  }

  return {
    async list(_req, res) {
      const [live, deleted] = await Promise.all([users.list(), users.listDeleted()]);
      await renderPage(res, 'pages/users/list', {
        pageTitle: 'Users',
        rows: live.map((u) => toUserRowView(u, timeZone)),
        deletedRows: deleted.map((u) => toUserDeletedRow(u, timeZone)),
        deletedColumns: USER_DELETED_COLUMNS,
      });
    },

    async newForm(_req, res) {
      await renderForm(res, { mode: 'create', values: { isActive: true, role: 'VIEWER' }, errors: {} });
    },

    async create(req, res) {
      const failure = createUserValidation.formFailure(res);
      if (failure) {
        await renderForm(res, { mode: 'create', values: failure.values, errors: failure.errors }, 400);
        return;
      }
      const { body } = createUserValidation.read(res);
      try {
        const user = await users.create(body, actorOf(req.user));
        setFlash(req, 'success', `User ${user.email} created`);
        res.redirect(303, '/users');
      } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODE.CONFLICT) {
          const values = withoutPassword(body);
          await renderForm(res, { mode: 'create', values, errors: conflictErrors(err) }, 409);
          return;
        }
        throw err;
      }
    },

    async editForm(_req, res) {
      const { params } = idValidation.read(res);
      const user = await users.getById(params.id);
      await renderForm(res, { mode: 'edit', id: user.id, values: { ...toUserFormValues(user) }, errors: {} });
    },

    async update(req, res) {
      const failure = updateUserValidation.formFailure(res);
      if (failure) {
        const id = typeof req.params['id'] === 'string' ? req.params['id'] : undefined;
        await renderForm(
          res,
          {
            mode: 'edit',
            ...(id === undefined ? {} : { id }),
            values: failure.values,
            errors: failure.errors,
          },
          400,
        );
        return;
      }
      const { params, body } = updateUserValidation.read(res);
      try {
        const user = await users.update(params.id, body, actorOf(req.user));
        setFlash(req, 'success', `User ${user.email} updated`);
        res.redirect(303, '/users');
      } catch (err) {
        if (
          err instanceof AppError &&
          (err.code === ERROR_CODE.CONFLICT || err.code === ERROR_CODE.LAST_ADMIN)
        ) {
          const values = withoutPassword(body);
          await renderForm(res, { mode: 'edit', id: params.id, values, errors: conflictErrors(err) }, 409);
          return;
        }
        throw err;
      }
    },

    async remove(req, res) {
      const { params } = idValidation.read(res);
      const removed = await users.remove(params.id, actorOf(req.user));
      setFlash(
        req,
        'success',
        `User ${removed.email} can no longer sign in and was moved to Deleted records.`,
      );
      res.redirect(303, '/users');
    },
  };
}
