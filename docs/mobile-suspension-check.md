# Blocking a suspended hiker in the PeakPath app (Flutter)

Written for whoever maintains the PeakPath mobile app.

The admin portal suspends a hiker by writing to their `users` record. Nothing
else happens on the server: there is no job, no push, no Auth change. The
suspension is just a date, and every client compares it with the clock. This
is the app's half of that.

## What the portal writes

`users/{uid}` — User Management > Suspend User:

| Field              | Type      | Meaning                                        |
| ------------------ | --------- | ---------------------------------------------- |
| `status`           | string    | `"Suspended"`                                  |
| `suspendedUntil`   | Timestamp | when it lifts; **absent or null = no end date**|
| `suspendedAt`      | Timestamp | when it started                                |
| `suspendedBy`      | string    | the admin's uid                                |
| `suspensionDays`   | number    | what the admin typed                           |
| `suspensionReason` | string?   | optional, meant to be shown to the hiker       |

The other blocking statuses stay as they are: `Inactive`, `Blocked`,
`Deactivated`, `Disabled`, `Banned` all lock the account with no end date.
`Pending` does **not** block — it means not yet approved, which is a different
decision.

## The rule, in one sentence

A hiker is locked out if their status is one of the blocking ones — except a
`Suspended` record whose `suspendedUntil` has already passed, which is over
and counts as active again.

This matches `jsPages/account-status.js` in the web repo exactly. If you
change one, change the other.

## Dart

```dart
import 'package:cloud_firestore/cloud_firestore.dart';

const _blockedStatuses = {
  'inactive', 'suspended', 'blocked', 'deactivated', 'disabled', 'banned',
};

class AccountBlock {
  final bool blocked;
  final String status;
  final DateTime? until;   // null when the block has no end date
  final String? reason;

  const AccountBlock({
    required this.blocked,
    required this.status,
    this.until,
    this.reason,
  });

  static const allowed = AccountBlock(blocked: false, status: 'Active');

  /// Days remaining, rounded up, so "0 days" is never shown for a block that
  /// is still running.
  int get daysLeft {
    if (until == null) return 0;
    final ms = until!.difference(DateTime.now()).inMilliseconds;
    return ms <= 0 ? 0 : (ms / Duration.millisecondsPerDay).ceil();
  }

  String get message {
    if (!blocked) return '';
    if (status.toLowerCase() != 'suspended') {
      return 'This account has been deactivated. Contact the PeakPath team.';
    }
    final base = until == null
        ? 'Your account is suspended.'
        : 'Your account is suspended for another $daysLeft '
          '${daysLeft == 1 ? 'day' : 'days'}.';
    return reason == null || reason!.isEmpty ? base : '$base\n\n$reason';
  }
}

/// The single source of truth. Give it a users document's data.
AccountBlock evaluateAccount(Map<String, dynamic>? data) {
  if (data == null) return AccountBlock.allowed;

  final status = (data['status'] ?? data['Status'] ?? 'Active').toString().trim();
  final lower = status.toLowerCase();
  if (!_blockedStatuses.contains(lower)) return AccountBlock.allowed;

  final reason = (data['suspensionReason'] as String?)?.trim();

  if (lower == 'suspended') {
    final raw = data['suspendedUntil'];
    final until = raw is Timestamp ? raw.toDate()
        : raw is DateTime ? raw
        : null;

    // No end date means it runs until an admin lifts it.
    if (until == null) {
      return AccountBlock(blocked: true, status: status, reason: reason);
    }
    // Served: the account is usable again, whatever `status` still says.
    if (!until.isAfter(DateTime.now())) return AccountBlock.allowed;

    return AccountBlock(
      blocked: true, status: status, until: until, reason: reason,
    );
  }

  return AccountBlock(blocked: true, status: status, reason: reason);
}

/// Reads the hiker's record. App sign-ups are keyed by uid; records the admin
/// created by hand get a random id and carry a `uid` field instead, so fall
/// back to that, then to email — the same order account-status.js uses.
Future<AccountBlock> checkAccount(String uid, {String? email}) async {
  final db = FirebaseFirestore.instance;

  final byId = await db.collection('users').doc(uid).get();
  if (byId.exists) return evaluateAccount(byId.data());

  final byUid = await db.collection('users')
      .where('uid', isEqualTo: uid).limit(1).get();
  if (byUid.docs.isNotEmpty) return evaluateAccount(byUid.docs.first.data());

  if (email != null && email.isNotEmpty) {
    final byEmail = await db.collection('users')
        .where('email', isEqualTo: email).limit(1).get();
    if (byEmail.docs.isNotEmpty) return evaluateAccount(byEmail.docs.first.data());
  }

  // No record at all: nothing has marked this account off, so let it in.
  return AccountBlock.allowed;
}
```

## Where to call it

**1. Right after sign-in — before you navigate to the home screen.**

```dart
final credential = await FirebaseAuth.instance
    .signInWithEmailAndPassword(email: email, password: password);

final check = await checkAccount(
  credential.user!.uid,
  email: credential.user!.email,
);

if (check.blocked) {
  await FirebaseAuth.instance.signOut();
  if (!mounted) return;
  showDialog(
    context: context,
    builder: (_) => AlertDialog(
      title: const Text('Account suspended'),
      content: Text(check.message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('OK'),
        ),
      ],
    ),
  );
  return;
}
// ...continue to the home screen
```

Sign out **before** showing the dialog. If you leave them signed in, the app
is holding a live session for an account that should not have one.

**2. On every app start, for a session that is already signed in.** Someone
suspended while the app was closed still has a valid token — Firebase Auth
knows nothing about your `users` collection. Run the same check in your splash
or auth-gate screen before routing to the home screen.

**3. Live, while the app is open — recommended.** So a hiker suspended
mid-session is pushed out rather than carrying on until they next restart:

```dart
FirebaseFirestore.instance.collection('users').doc(uid).snapshots()
    .listen((snap) {
  if (evaluateAccount(snap.data()).blocked) {
    FirebaseAuth.instance.signOut();
    // send them back to the login screen
  }
});
```

The web portal does exactly this in `dashboard-guard.js`.

## What happens when it expires

Nothing has to run. `suspendedUntil` passes, `evaluateAccount` starts
returning `allowed`, and the next sign-in works. The portal rewrites `status`
back to `Active` the next time an admin opens User Management, but that is
tidying up — it is not what lets them back in.

## Do not rely on this alone

This is a client check, and a client can be modified. The web repo's
`firestore.rules` carries a `notSuspended()` helper for the same suspension,
so a suspended uid is refused by the database whatever the app does. Both
layers matter: the rules stop the data, this stops the door.
