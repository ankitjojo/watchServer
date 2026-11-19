import type { AlertMode } from '../constants/alertMode.js';

export const ALERT_MODE_LABEL: Record<AlertMode, string> = {
  ONCE_WITH_RECOVERY: 'Once + recovery',
  EVERY_CHECK: 'Every check',
  REPEAT_EVERY: 'Repeat every N',
};
