#!/usr/bin/env bash
set -euo pipefail

# An exact, mergeable PR head receives checks from pull_request instead.
if [[ "$GITHUB_EVENT_NAME" == push && "$GITHUB_REF_TYPE" == branch && "$GITHUB_REF_NAME" != "$DEFAULT_BRANCH" ]]; then
  if pr_heads=$(gh api --method GET "repos/$GITHUB_REPOSITORY/pulls" \
    -f state=open -f "head=$GITHUB_REPOSITORY_OWNER:$GITHUB_REF_NAME" \
    -f per_page=100 --jq '.[] | [.number, .head.sha] | @tsv'); then
    while IFS=$'\t' read -r number sha; do
      if [[ "$sha" == "$HEAD_SHA" ]]; then
        if mergeable=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$number" --jq '.mergeable') && [[ "$mergeable" == true ]]; then
          echo 'run_checks=false' >> "$GITHUB_OUTPUT"
          exit 0
        fi
      fi
    done <<< "$pr_heads"
  fi
fi

echo 'run_checks=true' >> "$GITHUB_OUTPUT"

# New branches and unavailable history must retain the full check suite.
if [[ -z "$BASE_SHA" || "$BASE_SHA" =~ ^0+$ ]] || ! git cat-file -e "$BASE_SHA^{commit}" 2>/dev/null; then
  echo 'code_changed=true' >> "$GITHUB_OUTPUT"
  exit 0
fi

comparison="$BASE_SHA"
if [[ "$GITHUB_EVENT_NAME" == pull_request ]]; then
  comparison=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
fi

# Disabling rename detection keeps both paths, so moving code into docs is code.
git diff --name-only --no-renames -z "$comparison" "$HEAD_SHA" > "$RUNNER_TEMP/check-paths"
code_changed=false
while IFS= read -r -d '' path; do
  case "$path" in
    *.md | docs/*.json | docs/*.tsv) ;;
    *) code_changed=true ;;
  esac
done < "$RUNNER_TEMP/check-paths"
echo "code_changed=$code_changed" >> "$GITHUB_OUTPUT"
