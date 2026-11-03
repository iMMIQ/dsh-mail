// SPDX-License-Identifier: LGPL-3.0-or-later
/** Host registration of the same strict endpoint definitions selected by the client. */
import { TYPERT_REMOTE } from './remote.ts'

/** Loader reflection; no unrelated DSH service definitions are duplicated here. */
export const TYPERT = { package: 'dsh-mail', face: 'host' as const, schemas: [],
  get invocations() { return TYPERT_REMOTE.descriptors }, model: { services: [], events: [], objects: [] },
}
