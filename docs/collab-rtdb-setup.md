# Team chat — durable offline delivery (Realtime Database)

Team chat is delivered **P2P** to teammates who are online at send time. For
those who were **offline**, the sender also parks the message in a Realtime
Database (RTDB) queue; each member drains the messages addressed to them on
reconnect and the message is auto-deleted once everyone has it.

This is **client-side and best-effort**: with no RTDB configured (`rtdb()`
returns null) chat still works P2P — only offline delivery is skipped. No worker
/ service account is involved (unlike the old changeset relay).

> Whoever already received a message (P2P or earlier) is **not** in its
> `pending` set, so they never get it again.

## 1. Enable RTDB + config

1. Firebase Console → **Realtime Database** → Create database (project `maiplayer-ac56d`).
2. Add the DB URL to the IDE `.env`:
   ```
   VITE_FIREBASE_DATABASE_URL=https://maiplayer-ac56d-default-rtdb.firebaseio.com
   ```
   Without it everything else still works; offline delivery is a no-op.

The team roster (who must still receive a message) is read from Firestore
`teams/{teamId}.members` — no extra setup; a member can already read their own
team doc.

## 2. Data model

```
collabChat/{teamId}/{messageId}:
  msg:     { id, uid, name, text, ts }   // the ChatMessage
  pending: { <uid>: true, ... }          // members who have NOT received it yet
```

- **Send:** the author broadcasts P2P, then writes the message with
  `pending = roster − author − online-peers`. If everyone was online, nothing is
  written.
- **Receive:** a member's IDE subscribes (`onChildAdded`); for each message where
  it is in `pending`, it delivers the message (deduped by id), removes itself
  from `pending` (ACK), and deletes the whole node once `pending` is empty.

## 3. Security rules

Live in the **web monorepo** (`~/dev/web/toquemedia-studio`) as
`database.rules.json` (referenced by `firebase.json` →
`"database": { "rules": "database.rules.json" }`):

```json
{
  "rules": {
    "collabChat": {
      "$teamId": {
        ".read": "auth != null",
        ".write": "auth != null",
        "$msgId": {
          ".validate": "!newData.exists() || newData.hasChild('msg')",
          "pending": {
            "$uid": {
              ".write": "auth != null && ($uid === auth.uid || newData.exists())"
            }
          }
        }
      }
    }
  }
}
```

- Authenticated users read/write the queue. The `pending/$uid` rule lets a member
  only **remove their own** ACK flag (others may only be added, e.g. by the
  author on create).
- This is intentionally permissive (it doesn't verify team membership — RTDB
  can't read Firestore). The content is ephemeral chat and a teammate must know
  the random `teamId` to touch a queue. Tighten with a membership mirror in RTDB
  if stricter isolation is needed.

Deploy: `firebase deploy --only database`.

## 4. Local emulator

The emulator suite (`~/dev/web/toquemedia-studio`) runs RTDB on **port 9000**;
the IDE auto-connects in dev (`EMULATOR_CONFIG.DATABASE`). Restart the suite
after editing `database.rules.json` so the rules load.

## Lifecycle (recap)

- Send → P2P to online peers; for offline members, write `collabChat/{teamId}/{id}`.
- Each offline member reconnects → drains the messages where it's pending →
  ACKs (removes self) → deletes the node once `pending` is empty.
- Net: RTDB holds a message only until everyone has it; nothing lingers.
