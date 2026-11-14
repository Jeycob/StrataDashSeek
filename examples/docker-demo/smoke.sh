#!/bin/sh
set -eu
wget -q -O - "${BASE_URL:?BASE_URL is required}/" | grep -q HARNESS_DEPLOYED_APP_OK
printf '%s\n' 'PASS: deployed HTTP content'
