#!/bin/sh
# Rebuilds docs/semantic-enforcement-flow.{pdf,png} from the TikZ source.
# Requires pdflatex and pdftoppm (poppler-utils).
set -e
cd "$(dirname "$0")"
out=$(mktemp -d)
pdflatex -interaction=nonstopmode -halt-on-error -output-directory "$out" semantic-enforcement-flow.tex > "$out/build.log" || { tail -30 "$out/build.log"; exit 1; }
cp "$out/semantic-enforcement-flow.pdf" .
pdftoppm -png -r 220 -singlefile semantic-enforcement-flow.pdf semantic-enforcement-flow
rm -rf "$out"
echo "wrote docs/semantic-enforcement-flow.pdf and .png"
