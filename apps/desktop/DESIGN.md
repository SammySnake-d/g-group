# g-group desktop visual memory

## Product job

This screen lets a user choose a contact or group, read the current conversation,
and send the next message or attachment.

## Direction

The DS-Bot screenshot is a reference for spatial grammar rather than product
content: a calm paper surface, a single conversation list, a centered current
conversation pill, compact Bot/group rows, and an input that remains the visual
anchor at the bottom of the reading column.

g-group keeps its own paper/ink/柿-red brand tokens, so the adaptation uses the
DS-Bot blue only for the shell's active focus ring and brand mark. Domain state,
messages, model configuration, attachment delivery, announcements, pins and
Compute remain backed by g-group's existing store and wire layer.

## Information depth

- **L0 overview:** list rows show the contact/group name, latest message and
  minimum unread/running state.
- **L1 focus:** selecting a row opens the same chat object; the title pill and
  side panel expose the current conversation's details without losing context.
- **L2 manage:** settings, contact workbench and group tabs remain page/drawer
  surfaces reached from explicit controls.
- **L3 execute:** the composer is the primary action surface for sending text,
  mentions, replies and attachments; Compute and helper actions stay behind
  their existing explicit entry points.

## Interaction invariants

1. A real backend state or an honest loading/empty/error state is shown; no new
   visual seed data is introduced by this adaptation.
2. Every list row that represents a conversation remains selectable through the
   same `openFromList` path.
3. The centered title pill is still the existing chat/group details action.
4. The composer continues to use the existing draft, upload and send paths; the
   visual change does not create a second message transport.
5. Upstream attribution is visible in Settings, outside the primary chat flow.
