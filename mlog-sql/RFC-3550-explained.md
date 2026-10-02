# RFC 3550 jitter in the `jitter` view

Question: is RFC 3550 jitter wrong for MoQ objects? No. We use only its D:

    D = (R_j - S_j) - (R_i - S_i)    transit of this object minus the previous one's

- S is the sender's mlog send time, R the receiver's mlog receive time. RTP has
  to use its media timestamp as S; we have the real send time.
- Constant clock offset cancels in D, so no clock sync needed.
- Retransmits, flow control, and head-of-line blocking land in D. That's
  intended: this is object delivery jitter, what a player sees, not IP packet
  jitter. mlogs have no QUIC packet events, so packet jitter isn't available.
- The MoQ WG doesn't specify a jitter metric. We aren't claiming conformance.

Caveats:

- Object size: a keyframe's transit includes serialization, so D spikes at
  keyframe/delta boundaries. The view carries object size so charts can split
  by it.
- RFC's J is a 1/16 EWMA. A windowed mean of |D| is comparable, not identical.
- Label it "object jitter (RFC 3550 D, per object)", not "RFC 3550 jitter".
