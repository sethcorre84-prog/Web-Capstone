# Advisory audiences in the mobile app

The portal saves `Advisory/{id}.visibility` as `All Users` or `Guide`.
Email delivery already uses this audience. The mobile app now resolves the
signed-in account's `users/{uid}.role` (with `Role` as a legacy fallback)
before subscribing to advisories. A role containing `guide`, ignoring case,
can receive Guide advisories; other accounts query only public audiences.
This shared stream supplies the feed, unread indicators, and local alerts.

The Flutter project is `../ui_design_capstone`. Changes are in:

- `lib/features/report/report_service.dart`
- `lib/features/notification/push_notification_service.dart`
- `lib/features/functions/index.js`

The push function routes Guide advisories to `guide_advisories` instead of
the public `advisories` topic. The app subscribes according to account role
and notification preferences, and rechecks the current role before displaying
a Guide push. Email-only and hidden advisories do not generate app pushes.

## Release

1. Deploy the changed `pushOnAdvisory` function from the Flutter project:
   `firebase deploy --only functions:pushOnAdvisory`.
2. Deploy `firestore.rules` from this web project:
   `firebase deploy --only firestore:rules`.
3. Build and install the updated Flutter app. Older app builds query every
   advisory; after the rules deployment those queries are denied for hikers.

Older public audience labels `Registered Users` and `Premium Users` remain
supported. Documents missing `visibility` must be assigned the appropriate
audience in Firestore before they appear in the new non-guide query. Do not
assign a public audience to an advisory intended for guides.

## Account checks

With a guide account and a hiker account on separate devices, create a Guide
advisory with In-App enabled. Only the guide should see the feed entry,
unread indicator, foreground alert, and background push. An All Users advisory
should reach both. An Email-only advisory should appear in neither app feed
and generate no push. Also sign out of the guide account and sign in as a
hiker on the same device: Guide pushes must remain hidden.

Role changes take effect in the advisory stream when it is reopened; sign out
and back in after promoting or demoting an account to refresh subscriptions.
