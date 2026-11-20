import type { RequestHandler, Response } from 'express';
import { AppError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import type { AuthUser } from '../../types/express.js';
import { setFlash } from '../../utils/flash.js';
import { renderPage } from '../../utils/renderPage.js';
import { createRecipientValidation, idValidation, updateRecipientValidation } from './recipients.schemas.js';
import type { RecipientsService } from './recipients.service.js';
import {
  RECIPIENT_DELETED_COLUMNS,
  RECIPIENT_TYPE_OPTIONS,
  toRecipientDeletedRow,
  toRecipientFormValues,
  toRecipientRowView,
} from './recipients.view.js';

export interface RecipientsController {
  list: RequestHandler;
  newForm: RequestHandler;
  create: RequestHandler;
  editForm: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

function actorOf(user: AuthUser | undefined): { id: string; email: string } {
  // requireRole ran before this controller, so a user is always present.
  if (!user) throw new Error('authenticated user missing');
  return { id: user.id, email: user.email };
}

function conflictErrors(err: AppError): Record<string, string> {
  const details = err.details;
  const field =
    typeof details === 'object' && details !== null && 'field' in details && typeof details.field === 'string'
      ? details.field
      : '_form';
  return { [field]: err.message };
}

export function createRecipientsController(deps: {
  recipients: RecipientsService;
  timeZone: string;
}): RecipientsController {
  const { recipients, timeZone } = deps;

  function renderForm(
    res: Response,
    model: {
      mode: 'create' | 'edit';
      id?: string;
      isMaster?: boolean;
      values: Record<string, unknown>;
      errors: Record<string, string>;
    },
    status = 200,
  ): Promise<void> {
    return renderPage(
      res,
      'pages/recipients/form',
      {
        pageTitle: model.mode === 'create' ? 'New recipient' : 'Edit recipient',
        types: RECIPIENT_TYPE_OPTIONS,
        isMaster: false,
        ...model,
      },
      status,
    );
  }

  const isConflict = (err: unknown): err is AppError =>
    err instanceof AppError && (err.code === ERROR_CODE.CONFLICT || err.code === ERROR_CODE.MASTER_PROTECTED);

  return {
    async list(_req, res) {
      const [live, deleted] = await Promise.all([recipients.list(), recipients.listDeleted()]);
      await renderPage(res, 'pages/recipients/list', {
        pageTitle: 'Recipients',
        rows: live.map((r) => toRecipientRowView(r, timeZone)),
        deletedRows: deleted.map((r) => toRecipientDeletedRow(r, timeZone)),
        deletedColumns: RECIPIENT_DELETED_COLUMNS,
      });
    },

    async newForm(_req, res) {
      await renderForm(res, { mode: 'create', values: { type: 'NORMAL', isActive: true }, errors: {} });
    },

    async create(req, res) {
      const failure = createRecipientValidation.formFailure(res);
      if (failure) {
        await renderForm(res, { mode: 'create', values: failure.values, errors: failure.errors }, 400);
        return;
      }
      const { body } = createRecipientValidation.read(res);
      try {
        const recipient = await recipients.create(body, actorOf(req.user));
        setFlash(req, 'success', `Recipient ${recipient.email} created`);
        res.redirect(303, '/recipients');
      } catch (err) {
        if (isConflict(err)) {
          await renderForm(res, { mode: 'create', values: { ...body }, errors: conflictErrors(err) }, 409);
          return;
        }
        throw err;
      }
    },

    async editForm(_req, res) {
      const { params } = idValidation.read(res);
      const recipient = await recipients.getById(params.id);
      await renderForm(res, {
        mode: 'edit',
        id: recipient.id,
        isMaster: recipient.type === 'MASTER',
        values: toRecipientFormValues(recipient),
        errors: {},
      });
    },

    async update(req, res) {
      const failure = updateRecipientValidation.formFailure(res);
      if (failure) {
        const id = typeof req.params['id'] === 'string' ? req.params['id'] : undefined;
        await renderForm(
          res,
          {
            mode: 'edit',
            ...(id === undefined ? {} : { id }),
            isMaster: failure.values['type'] === 'MASTER',
            values: failure.values,
            errors: failure.errors,
          },
          400,
        );
        return;
      }
      const { params, body } = updateRecipientValidation.read(res);
      try {
        const recipient = await recipients.update(params.id, body, actorOf(req.user));
        setFlash(req, 'success', `Recipient ${recipient.email} updated`);
        res.redirect(303, '/recipients');
      } catch (err) {
        if (isConflict(err)) {
          await renderForm(
            res,
            {
              mode: 'edit',
              id: params.id,
              isMaster: body.type === 'MASTER',
              values: { ...body },
              errors: conflictErrors(err),
            },
            409,
          );
          return;
        }
        throw err;
      }
    },

    async remove(req, res) {
      const { params } = idValidation.read(res);
      const removed = await recipients.remove(params.id, actorOf(req.user));
      setFlash(
        req,
        'success',
        `Recipient ${removed.email} no longer receives alerts and was moved to Deleted records.`,
      );
      res.redirect(303, '/recipients');
    },
  };
}
