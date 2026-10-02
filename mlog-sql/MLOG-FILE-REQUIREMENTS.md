
# mlog file requirements

- we have really only done testing with a full set of mlog files: 
  - origin pub, final sub, and relay
  - we want to consider two relay (or more) scenarios, and cases where we only have subsets of mlog files available
- right now mlog file names must be of form cid_{client|server}.mlog or .mlog.gz
- i think we want to loosen that restriction