# TGPlayer UI Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Let a signed-in listener select Telegram chats, find an audio message, and begin reliable playback with minimum navigation. |
| Primary user and action | A Telegram user who curates music or audio in chats; the primary action is to play a track or resume the current queue. |
| Content hierarchy | 1) connection and playback state, 2) the next playable content, 3) library filters and management actions. |
| Navigation and controls | A stable left rail groups sources (Home, Chats, Library) before personal collections (Playlists, Queue, Favorites). Search is global and the bottom player is persistent. |
| Visual language | Cool blue Telegram-derived accents, lightly tinted surfaces, compact desktop spacing, real album/chat art where available, and one strong play action per view. Motion is short and must respect reduced-motion. |
| Required states | Signed out, connecting, sync in progress, empty library, empty collection, unavailable media, selected tracks, destructive cache/delete confirmation, and current playback. |
| Responsive behavior | Desktop keeps the rail and three-part player; medium width collapses rail labels and hides secondary metadata; narrow width keeps a single content column and essential playback controls. |
| Evidence used | Repository evidence: Telegram chats are the source, audio metadata is the library, and playback is the core operation. UIZZE's public landing page was reachable but did not expose searchable individual reference screens without an interactive catalogue session. |
| Forbidden defaults | Generic KPI cards, fabricated recommendations, unrelated dashboard metrics, decorative gradients that hide controls, and inert visual-only controls. |
| Acceptance criteria | Every screen makes its primary action obvious, uses consistent source/collection hierarchy, preserves existing control behavior, visibly distinguishes state, and remains usable at the existing 1150px, 900px, and 620px breakpoints. |
