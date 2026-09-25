# {{title}}

{{description}}

A Media over QUIC (MoQ) session with {{connection_count}} connections, each logged at both ends, for {{trace_count}} mlog traces in all. The publisher in {{publisher}} sent {{objects_published}} objects through the relay in {{relay}} to {{subscriber_count}} subscribers.

## Hosts

{{> hosts}}

## Latency by leg

Each object is matched across the logs at every hop: publisher to relay, time spent inside the relay, and relay to subscriber. The publisher-to-relay leg is one physical hop that every subscriber measures on its own, so those medians should agree. Here they are {{leg1_median_ms}} ms. End-to-end means run {{e2e_mean_ms}} ms.

{{> legs}}

The leg columns are medians: what a typical object saw. The end-to-end column is a mean, because means add up across legs and medians do not. Objects the relay held for a subscriber that joined late are left out, since their dwell measures the subscriber arriving, not the relay forwarding.

## What the logs can support

Every count below comes from the mlogs. An object counts as lost only if it was sent while both ends of its connection were still logging and never arrived. Objects sent after one end's log had stopped are counted apart, as outside the log window, because that silence belongs to the capture, not the network. Lost objects in this session: {{lost_objects}}.

{{> trust}}

A negative hop means the receiver's clock read earlier than the sender's. A nonzero count proves the two clocks disagree; zero proves nothing about them.
