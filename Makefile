MAP ?= reference/BattleShipsPro_v1.187.w3x
VENV := .venv

.PHONY: extract
extract: $(VENV)/bin/python
	$(VENV)/bin/python tools/extractor/extract.py $(MAP)

$(VENV)/bin/python:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r tools/extractor/requirements.txt
