#!/bin/bash

# Count instances of a process by pattern
# Usage: ./count_instances.sh "pattern"

PATTERN="$1"

if [ -z "$PATTERN" ]; then
    echo "Usage: $0 <pattern>"
    exit 1
fi

# Count matching processes, excluding grep itself and this script
ps aux | grep "$PATTERN" | grep -v grep | grep -v "count_instances.sh" | wc -l
