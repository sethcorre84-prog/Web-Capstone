# Advisory integration

The app and Web-Capstone use Firebase project `peakpath-ccd4a`, collection
`Advisory`, and the same Firestore rules. Keep both `firestore.rules` files
identical. Changes are local until explicitly deployed.

| Visibility | App audience | Push topic |
| --- | --- | --- |
| All Users | Signed-in hikers and guides | advisories |
| Hikers | Signed-in non-guide users | hiker_advisories |
| Guide | Signed-in guides | guide_advisories |

Guide detection accepts `role` or legacy `Role`, ignoring case and checking
for `guide`, consistently with the portal email recipients. Admins can read
all advisories; Viewers cannot create, edit or delete them. Users cannot
change either spelling of their own role. The app also checks audiences
when opening an old notification and when receiving a role-specific push.

The shared rules retain the app's account deactivation/reactivation, signup
cancellation, chats, community, admin sessions, two-factor settings and admin
role permissions. They also retain the portal's FAQ/checklist validation and
expired advisory protections, including archive and restore-as-expired.
Rules do not migrate existing documents. Advisories with missing visibility
or legacy `Registered Users` / `Premium Users` values must be reviewed and
saved with a current audience in A&A before they appear in the app.

## Local checks

From the app repository:

```powershell
firebase emulators:exec --only firestore --project demo-peakpath --config firebase.rules-test.json "node tool/advisory-rules-test.cjs"
```

This test refuses to run without a local emulator host. It uses only the
`demo-peakpath` project and checks audience queries and direct reads, admin
permissions, expired advisory edits, archive/restore, role changes, session
privacy, account deactivation/reactivation and FAQ validation.

## Deployment after review

Both repositories currently share the existing default Functions codebase.
Use `tool/deploy-functions.ps1` in each repository to deploy its explicitly
named exported functions. This avoids proposing deletion of functions that
exist only in the other repository. Do not use a broad `firebase deploy` or
`firebase deploy --only functions` for this split setup. The website folder
owns advisory email functions; the app folder owns advisory push functions.
Deploying website functions alone does not update app push targeting.

Review the rules diff and compare both files before deploying rules from
one repository. A rules deployment replaces the shared project's rules and
affects both clients. Hosting, Functions and Firestore rules are separate
deployment steps. No deployment is performed by the local tests.

Local checks do not prove the currently hosted website, installed APK,
deployed functions, FCM delivery, or deployed rules match these files.
After deployment, test with one hiker and one guide account: publish each
audience with In-App enabled and confirm the expected feed and push result.
Also verify a Viewer cannot publish, and an editor can archive/restore an
expired advisory.
