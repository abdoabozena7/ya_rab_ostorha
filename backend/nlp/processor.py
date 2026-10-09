"""Road-text normalization and rule-based interpretation; no driving commands."""
import re
import unicodedata


def interpret(text, confidence):
    normalized=' '.join(re.findall(r'[A-Z0-9]+',unicodedata.normalize('NFKC',text).upper()))
    tokens=normalized.split();kind='UNCLASSIFIED';value=None
    if confidence>=.45:
        if normalized=='STOP':kind='STOP'
        elif normalized in ('GIVE WAY','YIELD'):kind='YIELD'
        elif normalized=='ONE WAY':kind='ONE_WAY'
        elif normalized=='NO ENTRY':kind='NO_ENTRY'
        elif re.fullmatch(r'(?:SPEED(?: LIMIT)?|LIMIT)\s+(\d{1,3})',normalized):
            candidate=int(tokens[-1])
            if 5<=candidate<=130:kind='SPEED_LIMIT';value=candidate
        elif normalized=='SLOW':kind='CAUTION'
    return {'raw_text':text,'normalized_text':normalized,'tokens':tokens,
            'instruction':kind,'value':value,'confidence':confidence,'method':'RULE_BASED_TEXT_PROCESSING'}
