import type { Config } from '../../config/loadConfig.js';
import type { Logger } from '../../logger/index.js';
import type { RecipientsService } from './recipients.service.js';

/** FR-R3: create the first master recipient from .env when none exists. */
export async function seedMasterRecipient(deps: {
  recipients: Pick<RecipientsService, 'countMasters' | 'ensureMaster'>;
  seed: Config['seed'];
  logger: Logger;
}): Promise<boolean> {
  const { recipients, seed, logger } = deps;
  if ((await recipients.countMasters()) > 0) return false;
  if (!seed.master) {
    throw new Error(
      'No master recipient exists. Set MASTER_ALERT_EMAIL (and MASTER_ALERT_NAME) to create one.',
    );
  }
  await recipients.ensureMaster(seed.master.email.trim().toLowerCase(), seed.master.name);
  logger.info({ event: 'seed.master' }, 'Master recipient created from environment');
  return true;
}
