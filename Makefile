MAP ?= reference/BattleShipsPro_v1.187.w3x
VENV := .venv

.PHONY: extract terrain
extract: $(VENV)/bin/python
	$(VENV)/bin/python tools/extractor/extract.py $(MAP)
	$(MAKE) terrain

# Parse the WC3 pathing map (war3map.wpm, already in data/extracted) into the
# static land/water mask data/json/terrain.json. Pure stdlib: no venv needed,
# and reproducible without the (gitignored) .w3x.
terrain:
	python3 tools/extractor/terrain.py

$(VENV)/bin/python:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r tools/extractor/requirements.txt
