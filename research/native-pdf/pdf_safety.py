"""Shared, bounded preflight checks for local PDF repair experiments."""
from pypdf.generic import ArrayObject, DictionaryObject

MAX_SIGNATURE_NODES = 10_000
MAX_FIELD_PARENT_DEPTH = 64


def resolved(value):
    return value.get_object() if value is not None else None


def reject_signed_pdf(reader):
    """Reject canonical signature fields and orphan/inherited page widgets."""
    root = reader.trailer["/Root"]
    if root.get("/Perms") is not None:
        raise ValueError("signed_pdf_not_supported")
    inspected = 0

    def inspect_chain(item):
        nonlocal inspected
        seen = set()
        for _ in range(MAX_FIELD_PARENT_DEPTH):
            item = resolved(item)
            if item is None:
                return
            if not isinstance(item, DictionaryObject) or id(item) in seen:
                raise ValueError("signature_structure_invalid")
            seen.add(id(item))
            inspected += 1
            if inspected > MAX_SIGNATURE_NODES:
                raise ValueError("signature_structure_limit")
            value = resolved(item.get("/V"))
            if item.get("/FT") == "/Sig" or (
                isinstance(value, DictionaryObject) and value.get("/Type") == "/Sig"
            ):
                raise ValueError("signed_pdf_not_supported")
            item = item.get("/Parent")
        raise ValueError("signature_structure_limit")

    form = resolved(root.get("/AcroForm"))
    if form is not None:
        if not isinstance(form, DictionaryObject):
            raise ValueError("signature_structure_invalid")
        fields = resolved(form.get("/Fields", ArrayObject()))
        if not isinstance(fields, ArrayObject) or len(fields) > MAX_SIGNATURE_NODES:
            raise ValueError("signature_structure_limit")
        pending, visited = list(fields), set()
        while pending:
            item = resolved(pending.pop())
            if not isinstance(item, DictionaryObject):
                raise ValueError("signature_structure_invalid")
            if id(item) in visited:
                continue
            visited.add(id(item))
            inspect_chain(item)
            children = resolved(item.get("/Kids", ArrayObject()))
            if not isinstance(children, ArrayObject) or len(children) + len(pending) > MAX_SIGNATURE_NODES:
                raise ValueError("signature_structure_limit")
            pending.extend(children)

    annotation_count = 0
    for page in reader.pages:
        annotations = resolved(page.get("/Annots", ArrayObject()))
        if not isinstance(annotations, ArrayObject):
            raise ValueError("signature_structure_invalid")
        annotation_count += len(annotations)
        if annotation_count > MAX_SIGNATURE_NODES:
            raise ValueError("signature_structure_limit")
        for reference in annotations:
            annotation = resolved(reference)
            if not isinstance(annotation, DictionaryObject):
                raise ValueError("signature_structure_invalid")
            if annotation.get("/Subtype") == "/Widget":
                inspect_chain(annotation)
