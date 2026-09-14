# Local attachment scanning

The supported no-external-API option is a self-hosted **ClamAV `clamd`** daemon.
The bridge sends bytes through a Unix socket on the same host (or a shared socket
volume between containers). It never uploads attachments to a reputation API.
ClamAV must be installed and maintained by the server administrator; it is not
bundled or installed automatically by the desktop app.

## Commercial distribution boundary

ClamAV is **GPLv2, not MIT**. Commercial use is permitted, but redistribution
and linking obligations are different from permissive licenses. This integration
contains an independently written INSTREAM client using Node's standard library;
it does not import `libclamav`, copy engine code, bundle the engine, or redistribute
signature databases. Administrators install and update the separate daemon.

Keep that boundary when packaging a commercial product. If a future installer,
container image or appliance includes ClamAV, review that exact release and its
third-party notices, license text and corresponding-source obligations before
shipping. A socket or container boundary alone is not a universal legal guarantee.
Have licensing counsel approve any bundling/linking change. Do not advertise the
scanner itself as MIT or this review as a complete product license audit.

The installed mail clients checked for this implementation are ImapFlow **1.3.2**
(package metadata: MIT; bundled permissive license text) and Nodemailer **8.0.6**
(MIT-0). Both permit commercial use. No new external npm dependency was added for
the scanner, OAuth mailbox operations or warm-up scheduler. Continue to include
the licenses/notices required by the full resolved dependency tree in release
artifacts; provider API/consent terms are separate from open-source licenses.

Their installed runtime dependency closure was checked as well: MIT, MIT-0 and
ISC, plus `@zone-eu/mailsplit@5.4.9` under `(MIT OR EUPL-1.1+)`. For this
commercial integration choose its **MIT** alternative and retain its bundled
`LICENSE.MIT` copyright/permission notice. An OR choice does not require adopting
the EUPL alternative. Recheck resolved versions on dependency updates.

The desktop Communications regression runner includes
`tests/unit/mail-commercial-license-boundary.ts`, which traverses the installed
mail-client runtime dependencies and fails on unreviewed license choices. This
does not audit the whole app, validate provider contracts, or replace shipping
the required notices. Check optional dependencies on every shipped platform.

Sources: [ClamAV license](https://docs.clamav.net/Introduction.html#license),
[GNU commercial-use and aggregation FAQ](https://www.gnu.org/licenses/gpl-faq.html.en),
[ImapFlow license](https://github.com/postalsys/imapflow/blob/master/LICENSE.txt),
[Nodemailer license](https://nodemailer.com/license).

## Setup

Configure `clamd` with `LocalSocket /run/clamav/clamd.sock`, restrict socket access
to the bridge service user/group, and configure these bridge environment values:

```
TEAMSPACE_CLAMAV_SOCKET=/run/clamav/clamd.sock
TEAMSPACE_CHAT_SCAN_REQUIRED=1
```

Mount the socket directory into the bridge container when using containers.
Do not expose unauthenticated clamd TCP ports. Restart the bridge after changing
these settings. An invalid path, missing daemon, timeout, busy scanner, size
limit, malformed response or malware verdict refuses access; it never counts
as a clean scan. The stock bridge now registers this integration when the socket
is configured. Requiring scanning without a configured engine still blocks access.

The bridge uses a 30-second wall deadline, 64 MiB scan ceiling, and at most two
active scans. Align `StreamMaxLength` with your permitted upload size. Configure
ClamAV archive recursion, extracted-size and file-count limits and enable
`AlertExceedsMax`, encrypted archive/document alerts, and appropriate document
heuristics. Files the engine cannot inspect must be treated as blocked, not
clean. Keep signature updates (`freshclam`) running; signature downloads do not
send document contents outside your server. Monitor signature age and daemon
health. A scanner is risk reduction, not a guarantee that every threat is detected.

Team Chat scans new uploads, deduplicated re-uploads and downloads of old stored
blobs before exposing bytes, with authorization checked again after scanning.
Bytes are held in bounded memory until the scan verdict; rejected uploads are
not published. There is no user-accessible quarantine release/bypass button.

## Desktop mail attachments

Project IMAP and private OAuth mail use the desktop's own local daemon for
**Scan and save**. A daemon available only on the bridge server does not provide
the desktop scan. Install and maintain clamd separately on the user's computer,
then launch the desktop app with an absolute local socket path, for example:

```
AITOMATION_CLAMAV_SOCKET=/absolute/path/to/clamd.sock
```

Alternatively, the desktop can connect to a separately configured clamd service
on `127.0.0.1:3310`. It never chooses an external scanner host. Restrict the Unix
socket to the desktop user's access or bind TCP to loopback only. Restart the
desktop after configuring its launch environment. No installer, engine binary,
engine library or signature database is added to the commercial app package.
The separate-daemon distribution boundary above still applies.

Desktop mail permits at most 10 MiB of decoded attachment bytes and two active
scans, with a 30-second scan deadline. Set `StreamMaxLength` to at least 10 MiB,
enable `AlertExceedsMax` and `AlertEncrypted`, configure archive/document limits,
and keep signatures current with freshclam. The daemon's configuration and
signature age are administrator responsibilities; the INSTREAM response alone
cannot prove that every engine inspection rule is enabled.

The exact bytes are scanned in bounded native memory before the native save
dialog is shown. An unavailable, busy, timed-out, malformed or negative scan
blocks saving. Profile/message/caller authority is checked again after fetch,
scan and dialog completion. The scanned snapshot is cleared after use. Files
are published with private permissions and without overwriting existing files
or symlinks; the app never automatically opens, previews or extracts them.
Antivirus does not detect all phishing, misleading text or embedded instructions
and cannot guarantee that an attachment is safe.

Desktop protocol/filesystem/storage checks:
`node --import tsx tests/unit/imap-mailbox-safety-real.ts` from `apps/desktop`.
This uses a local protocol fixture, not a real antivirus engine or mail provider.
See [IMAP folder synchronization](../../../docs/communications-imap.md) for the
bounded automatic folder schedule and attachment identity checks.

Verify protocol boundaries with `node --import tsx tests/attachment-clamav.ts`.
For a real clean-file/EICAR integration check set `TEST_CLAMAV_SOCKET` to your
test daemon's socket before running that test. Without it, the test explicitly
reports that real antivirus detection was not run.

Protocol reference: https://docs.clamav.net/manual/Usage/ClamdProtocol.html
