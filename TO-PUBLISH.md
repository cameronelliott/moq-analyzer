

# Things we need TO DO and NOT DO before publication/release of the analyzer


## under consideration


## must do before release

- review/explore whether current per-subscriber time-series is ideal
- review what mlog file combinations are valid
- handle relay-only mlog file combinations
- add progress bars to file loading
- test non-json files
- test invalid mlog files
- accept vanilla moq-rs mlog files missing "stream_id"
- accept vanilla moq-rs mlog files missing "reference_time"
- accept non CID-client/server format file names
- dialog explaining what happens with log files
- better loading and caching of the duckdb and other big assets

## should not do before release

