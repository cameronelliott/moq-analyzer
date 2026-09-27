---
title: Events
order: 6
---

# Events

Every event in one shape, in time order: the mlog schema's `event` view. The
first moments of the relay's trace for sub-1.

| Time (UTC) | Event | Stream | Track | Group / object | Bytes | Message |
| --- | --- | --- | --- | --- | --- | --- |
| 13:00:00.000 | control_message_parsed | 0 | | | | client_setup |
| 13:00:00.001 | control_message_created | 0 | | | | server_setup |
| 13:00:00.043 | control_message_parsed | 0 | 0.mp4 | | | subscribe |
| 13:00:00.044 | control_message_created | 0 | 0.mp4 | | | subscribe_ok |
| 13:00:00.158 | control_message_parsed | 0 | video | | | subscribe |
| 13:00:00.159 | control_message_created | 0 | video | | | subscribe_ok |
| 13:00:00.161 | control_message_parsed | 0 | audio | | | subscribe |
| 13:00:00.162 | control_message_created | 0 | audio | | | subscribe_ok |
| 13:00:00.190 | subgroup_header_created | 3 | video | 412 / | | |
| 13:00:00.190 | subgroup_object_created | 3 | video | 412 / 0 | 41,872 | |
| 13:00:00.223 | subgroup_object_created | 3 | video | 412 / 1 | 3,904 | |
| 13:00:00.231 | subgroup_header_created | 7 | audio | 1650 / | | |
| 13:00:00.231 | subgroup_object_created | 7 | audio | 1650 / 0 | 412 | |
| 13:00:00.256 | subgroup_object_created | 3 | video | 412 / 2 | 4,118 | |

A real Events view would page through hundreds of thousands of rows, and is
the one view that wants a live query rather than a built table.
