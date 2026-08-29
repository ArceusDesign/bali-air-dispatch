/**
 * Root middleware — redirects the old baliair.pages.dev domain to the
 * canonical baliairdispatch.com one, preserving path and query string.
 * A hostname-scoped rule in _redirects does not fire against the project's
 * own *.pages.dev domain, so this runs at the Functions layer instead,
 * which every request (static or Function-routed) passes through first.
 * Preview deployments (<hash>.baliair.pages.dev) are an exact-match miss
 * here on purpose — they must keep working unredirected.
 *
 * /api/* IS DELIBERATELY NOT REDIRECTED, and this is load-bearing.
 *
 * When this middleware first shipped it redirected everything, which silently
 * killed a contributor's sensor 27 seconds later: the device POSTs readings to
 * /api/ingest on the hostname it was configured with months ago, and a
 * redirect breaks that two separate ways, either of which is fatal.
 *
 *   1. METHOD/BODY. A 301 is not required to preserve the method, and most
 *      HTTP clients — curl included, by default — either refuse to follow a
 *      redirect for POST at all or downgrade it to a bodyless GET. Embedded
 *      firmware typically does not follow redirects in the first place. The
 *      reading is simply dropped, and the device has no way to notice.
 *   2. CREDENTIALS. Even a 307/308, which does preserve method and body, does
 *      not save this: clients strip the Authorization header when a redirect
 *      crosses to a different host, precisely so a redirect cannot exfiltrate
 *      a bearer token. So the POST would arrive unauthenticated and earn a 401.
 *
 * Switching the status code therefore does NOT fix it — only not redirecting
 * does. A device in the field cannot be expected to chase a domain change, and
 * we cannot reach out and reconfigure it. Both hostnames must keep serving the
 * API directly, indefinitely. Human-facing pages still redirect, so the
 * canonical domain is what people see, link and share.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === 'baliair.pages.dev' && !url.pathname.startsWith('/api/')) {
    url.hostname = 'baliairdispatch.com';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
