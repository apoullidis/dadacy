/**
 * `GET /v1/meta/platform-fee` — `T-022`'s operation, served. No new endpoint.
 *
 * The PATH is not written here: it is read from `OPERATIONS` in
 * `packages/contracts`, the source the published document is generated from,
 * so the served route cannot drift from the document's path by an edit to
 * this file. The BODY is parsed by the contract's own Zod schema before it is
 * returned, so a body that schema refuses throws a ZodError, which the filter
 * answers as a non-domain 500. That refusal is NOT planted in any test; what is
 * tested is that the served body validates against the committed document
 * (`test/container.test.ts`).
 */
import { Controller, Get } from '@nestjs/common';
import {
  OPERATIONS,
  PlatformFee,
  encodeMinorUnits,
  type PlatformFeeBody,
} from '@kinvara/contracts';
import { decorateClass, decorateMethod, injectParams } from '../nest-decorate.ts';
import { PLATFORM_FEE_SOURCE, type PlatformFeeSource } from './platform-fee.source.ts';

const operation = OPERATIONS.find((o) => o.operationId === 'getPlatformFee');
if (operation === undefined || operation.method !== 'get') {
  throw new TypeError(
    'meta.controller: packages/contracts declares no GET getPlatformFee operation',
  );
}

export class MetaController {
  readonly #source: PlatformFeeSource;

  constructor(source: PlatformFeeSource) {
    this.#source = source;
  }

  getPlatformFee(): PlatformFeeBody {
    return PlatformFee.parse({
      currency: 'EUR',
      amountMinor: encodeMinorUnits(this.#source.currentMinor()),
    });
  }
}
decorateClass(MetaController, Controller());
decorateMethod(MetaController, 'getPlatformFee', Get(operation.path));
injectParams(MetaController, [PLATFORM_FEE_SOURCE]);
