# TGPlayer UI Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Let a signed-in listener select Telegram chats, find an audio message, and begin reliable playback with minimum navigation. |
| Primary user and action | A Telegram user who curates music or audio in chats; the primary action is to play a track or resume the current queue. |
| Content hierarchy | 1) connection and playback state, 2) the next playable content, 3) library filters and management actions. |
| Navigation and controls | A stable left rail groups sources (Home, Chats, Library) before personal collections (Playlists, Queue, Favorites). Search is global and the bottom player is persistent. |
| Visual language | Cool blue Telegram-derived accents, lightly tinted surfaces, compact desktop spacing, real album/chat art where available, and one strong play action per view. Motion is short and must respect reduced-motion. |
| Motion | Timings and curves follow Telegram Desktop's motion language, defined once as tokens in `src/motion.css` and driven by `src/motion.js`: 100–200ms for micro-interactions, 150–200ms for transitions, 200–320ms for entrances, with entering and leaving deliberately asymmetric (leave slower, on an ease-in curve). Ripple press ink, list stagger, cross-fading text, rolling counters, parabolic fly-to-target and error shake are the shipped elements. Nothing is allowed to be slow for its own sake, and both the in-app switch and the OS `prefers-reduced-motion` setting jump animations to their final state rather than shortening them. Full spec: `docs/motion-spec.md`. |
| Required states | Signed out, connecting, sync in progress, empty library, empty collection, unavailable media, selected tracks, destructive cache/delete confirmation, and current playback. |
| Responsive behavior | Desktop keeps the rail and three-part player; medium width collapses rail labels and hides secondary metadata; narrow width keeps a single content column and essential playback controls. |
| Evidence used | Repository evidence: Telegram chats are the source, audio metadata is the library, and playback is the core operation. UIZZE's public landing page was reachable but did not expose searchable individual reference screens without an interactive catalogue session. |
| Forbidden defaults | Generic KPI cards, fabricated recommendations, unrelated dashboard metrics, decorative gradients that hide controls, and inert visual-only controls. |
| Acceptance criteria | Every screen makes its primary action obvious, uses consistent source/collection hierarchy, preserves existing control behavior, visibly distinguishes state, and remains usable at the existing 1150px, 900px, and 620px breakpoints. |
