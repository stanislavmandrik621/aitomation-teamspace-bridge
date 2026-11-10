import { guestPageDocument } from './guest-page-theme.js'
import { GUEST_GATE_JS } from './guest-page-render.js'
import { COMPOSE_REVIEW_CSS, COMPOSE_REVIEW_JS } from './compose-guest-viewer.js'

/** Password-gated, view-only canvas; the editable source is never published. */
export function composeGuestPage(token: string, internalReview = false): string {
  const safeToken = JSON.stringify(token).replace(/</g, '\\u003c')
  return guestPageDocument({
    title: 'Shared board review',
    bodyHtml: `<style>${COMPOSE_REVIEW_CSS}</style><div id="app"></div>`,
    scriptJs: `var token=${safeToken};var reviewPath=location.pathname;${GUEST_GATE_JS}${COMPOSE_REVIEW_JS}`,
  })
}
