MAP ?= reference/BattleShipsPro_v1.187.w3x
VENV := .venv

.PHONY: extract terrain
extract: $(VENV)/bin/python
	$(VENV)/bin/python tools/extractor/extract.py $(MAP)
	$(MAKE) terrain

# Build the static land/water mask data/json/terrain.json by CLASSIFYING the map's
# own embedded minimap (data/reference/war3mapMap.png, owner-confirmed correct) per
# terrain tile via the owner's CONFIRMED colour key: SAILABLE WATER = NON-BLUE
# (yellow deep + green shallow + pink passable), LAND = only the blue-dominant ridge
# pixels. Then carve only MINIMAL 1-cell necks so every shop + dock/spawn reaches the
# sea and the two bases stay connected, PLUS the two owner-approved WEST sail-around
# island moats (Swedish Lumber Mill + Goblin Potion Dealer: a 25-cell land core ringed
# by a closed 1-cell water loop with EXACTLY ONE entrance each; the green shallow water
# already rings the blue cores, so the loops largely emerge naturally).
# war3map.w3e is read only for the grid geometry, then CROPPED to the playable
# rectangle (the unplayable border removed; the WEST bound is extended 3 cells west
# of the camera bounds so the Goblin Potion Dealer shop sits off the grid edge on a
# sail-around island -- see terrain.py WEST_EXTEND_CELLS). The optional `depth` field
# (0=land,1=deep,2=shallow,3=pink) is additive render metadata the sim IGNORES. Pure
# stdlib (a pure-stdlib PNG decoder reads the committed minimap): no venv needed,
# byte-reproducible without the (gitignored) .w3x. Also writes the 3-panel
# data/reference/colorkey-compare.png (minimap | rebuilt 4-shade mask + shop dots |
# land-vs-water diff) and the zoomed [before | after] data/reference/westedge-compare.png
# of the two west sail-around island rings, and prints the colour-key agreement. Fails
# loud if the mask does not pass the structures-on-water / base-to-base /
# all-shops-reachable / colour-key-agreement / water-fraction gates.
terrain:
	python3 tools/extractor/terrain.py

$(VENV)/bin/python:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r tools/extractor/requirements.txt
