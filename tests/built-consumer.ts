// SPDX-License-Identifier: LGPL-3.0-or-later
/** Type-check the published declaration entry against its last emitted artifacts. */
import MailAutomation, { Config, MailRuntime } from '../lib/index.js'

const validate = Config['~standard'].validate
const status: (service: MailAutomation | MailRuntime) => object = service => service.status()
void validate
void status
