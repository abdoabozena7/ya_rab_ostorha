# NLP

This section performs lightweight deterministic processing of text actually read from the camera. It contains no LLM, language-model download or trained NLP model.

## Inputs and outputs

`processor.py::interpret(raw_text, confidence)` accepts an OCR string and its recognizer score. It returns the original text, normalized text, tokens, confidence, instruction kind, optional numeric speed value and processing method. The CV worker wraps these outputs with their own source frame, timestamp and session.

## Algorithm and runtime call

Unicode NFKC normalization, uppercase conversion, punctuation cleanup and whitespace tokenization precede conservative rules for STOP, YIELD / GIVE WAY, SPEED LIMIT, ONE WAY, NO ENTRY and SLOW. Unmatched or low-confidence text stays UNCLASSIFIED. Speed values must be in the documented 5–130 range.

`backend/computer_vision/worker.py` calls this function only on actual recognized crops. The dashboard shows raw text, interpreted kind, score and source frame. This analysis does not actuate the car; RULE safety remains the experiment's protection.

## Demonstration and study questions

Start the project, inspect the detection/sign reading panel and open `processor.py` in your code editor. For a small direct example: `python -c "from backend.nlp.processor import interpret; print(interpret('SPEED LIMIT 30', .9))"`. This is an algorithm demonstration, not a measured CARLA sign detection.

Why rules rather than a neural language model? The vocabulary is small and predictable, so deterministic parsing is inexpensive and explainable. What happens after OCR mistakes? The original text and confidence remain visible, and unmatched strings are not silently promoted to traffic instructions. Limitations: English-only recognition, no semantic context or Arabic interpretation, no OCR error correction guarantee, and uncalibrated confidence.
