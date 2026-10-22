"""Terminal control inventory, source-stable identities and refusal boundaries."""
import io
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DictionaryObject,
                          FloatObject, NameObject as N, NumberObject as I,
                          TextStringObject as T)

import native_form_inventory as inventory
import hybrid_forms
from test_hybrid_forms import fixture as hybrid_fixture


def saved(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def fixture(*, separate=False, two_pages=False):
    writer = PdfWriter()
    pages = [writer.add_blank_page(200, 200)]
    if two_pages:
        pages.append(writer.add_blank_page(200, 200))
    group = DictionaryObject({N('/T'): T('section'), N('/FT'): N('/Tx'),
        N('/TU'): T('Inherited instructions'), N('/Ff'): I(2), N('/V'): T('Example')})
    group_ref = writer._add_object(group)
    field = DictionaryObject({N('/T'): T('name'), N('/Parent'): group_ref})
    field_ref = writer._add_object(field)
    group[N('/Kids')] = ArrayObject([field_ref])
    widgets = []
    for index, page in enumerate(pages):
        if separate:
            widget = DictionaryObject({N('/Parent'): field_ref})
            ref = writer._add_object(widget)
        else:
            assert len(pages) == 1
            widget, ref = field, field_ref
        widget.update({N('/Type'): N('/Annot'), N('/Subtype'): N('/Widget'),
            N('/P'): page.indirect_reference,
            N('/Rect'): ArrayObject([I(10), I(20 + index), I(150), I(40 + index)])})
        # A non-widget annotation demonstrates IDs refer to annotation positions,
        # not the widget's ordinal position in this inventory.
        link = writer._add_object(DictionaryObject({N('/Type'): N('/Annot'),
            N('/Subtype'): N('/Link'), N('/Rect'): ArrayObject([I(0)] * 4)}))
        page[N('/Annots')] = ArrayObject([link, ref])
        widgets.append(widget)
    if separate:
        field[N('/Kids')] = ArrayObject([widget.indirect_reference for widget in widgets])
    form = DictionaryObject({N('/Fields'): ArrayObject([group_ref])})
    writer.root_object[N('/AcroForm')] = writer._add_object(form)
    return writer, group, field, widgets, form


class NativeFormInventoryTests(unittest.TestCase):
    def report(self, writer):
        return inventory.native_form_inventory(PdfReader(io.BytesIO(saved(writer)), strict=True))

    def refused(self, writer, code='native_pdf_unsupported'):
        with self.assertRaises(inventory.NativeFormInventoryError) as error:
            inventory.native_form_inventory(writer)
        self.assertEqual(str(error.exception), code)
        self.assertEqual(error.exception.code, code)

    def test_group_is_not_a_control_and_attributes_are_inherited(self):
        writer, _, _, _, _ = fixture()
        report = self.report(writer)
        self.assertEqual((report['field_count'], report['widget_count']), (1, 1))
        row = report['fields'][0]
        self.assertEqual({key: row[key] for key in ('name', 'type', 'label', 'required', 'value')},
            {'name': 'section.name', 'type': 'Tx', 'label': '', 'required': True, 'value': 'Example'})
        self.assertEqual(row['pageNumbers'], [1])
        self.assertEqual(row['widgets'], [{'widgetId': 'p1-a2', 'pageNumber': 1, 'rect': [10., 20., 150., 40.]}])
        self.assertEqual(row['speech'], {'supported': False, 'text': None, 'disabled': None,
            'priority': None, 'source': 'xfa-assist'})

    def test_parent_tooltip_does_not_hide_a_missing_terminal_label(self):
        writer, group, field, _, _ = fixture()
        self.assertEqual(group['/TU'], 'Inherited instructions')
        self.assertEqual(self.report(writer)['fields'][0]['label'], '')
        field[N('/TU')] = T('Terminal control instructions')
        self.assertEqual(self.report(writer)['fields'][0]['label'], 'Terminal control instructions')

    def test_terminal_overrides_include_intentionally_empty_label_and_value(self):
        writer, _, field, _, _ = fixture()
        field.update({N('/FT'): N('/Btn'), N('/Ff'): I(0), N('/TU'): T(''), N('/V'): N('/Off')})
        row = self.report(writer)['fields'][0]
        self.assertEqual((row['type'], row['label'], row['required'], row['value']), ('Btn', '', False, '/Off'))
        field[N('/V')] = T('')
        self.assertEqual(self.report(writer)['fields'][0]['value'], '')

    def test_separate_widgets_on_multiple_pages_are_one_terminal_control(self):
        writer, _, _, _, _ = fixture(separate=True, two_pages=True)
        report = self.report(writer)
        self.assertEqual((report['field_count'], report['widget_count']), (1, 2))
        self.assertEqual(report['fields'][0]['pageNumbers'], [1, 2])
        self.assertEqual([w['widgetId'] for w in report['fields'][0]['widgets']], ['p1-a2', 'p2-a2'])

    def test_duplicate_names_never_collapse_distinct_native_controls(self):
        writer, group, _, widgets, _ = fixture()
        duplicate = DictionaryObject({key: value for key, value in widgets[0].items()})
        duplicate_ref = writer._add_object(duplicate)
        group['/Kids'].append(duplicate_ref)
        writer.pages[0]['/Annots'].append(duplicate_ref)
        rows = self.report(writer)['fields']
        self.assertEqual([row['name'] for row in rows], ['section.name', 'section.name'])
        self.assertNotEqual(rows[0]['fieldId'], rows[1]['fieldId'])

    def test_ids_survive_object_renumbering_values_and_labels(self):
        writer, _, field, _, _ = fixture()
        before = self.report(writer)['fields'][0]['fieldId']
        field[N('/TU')] = T('More specific instruction')
        field[N('/V')] = T('Changed fictional value')
        writer._add_object(DictionaryObject({N('/Unused'): T('object numbering is irrelevant')}))
        reopened = PdfWriter(clone_from=PdfReader(io.BytesIO(saved(writer))))
        self.assertEqual(self.report(reopened)['fields'][0]['fieldId'], before)

    def test_no_form_and_empty_form_return_empty_inventory(self):
        writer = PdfWriter()
        writer.add_blank_page(100, 100)
        empty = {'fields': [], 'field_count': 0, 'widget_count': 0}
        self.assertEqual(inventory.native_form_inventory(writer), empty)
        writer.root_object[N('/AcroForm')] = DictionaryObject({N('/Fields'): ArrayObject()})
        self.assertEqual(inventory.native_form_inventory(writer), empty)

    def test_terminal_without_widget_remains_visible_as_nonvisual_field(self):
        writer, _, field, _, _ = fixture()
        field.pop(N('/Subtype'))
        writer.pages[0][N('/Annots')] = ArrayObject()
        row = self.report(writer)['fields'][0]
        self.assertEqual(row['widgets'], [])
        self.assertEqual(row['pageNumbers'], [])

    def test_malformed_and_unknown_flags_are_not_reported_as_optional(self):
        for flags in (BooleanObject(False), T('not a number'), I(-1), I(1 << 32), FloatObject(2.5)):
            writer, group, _, _, _ = fixture()
            group[N('/Ff')] = flags
            with self.subTest(flags=type(flags).__name__):
                self.refused(writer)

    def test_wrong_parent_cycles_and_reused_fields_are_rejected(self):
        for variant in ('parent', 'cycle', 'reuse'):
            writer, group, field, _, form = fixture()
            if variant == 'parent':
                field[N('/Parent')] = writer._add_object(DictionaryObject())
            elif variant == 'cycle':
                group[N('/Kids')] = ArrayObject([group.indirect_reference])
            else:
                form['/Fields'].append(group.indirect_reference)
            with self.subTest(variant=variant):
                self.refused(writer)

    def test_orphan_missing_and_duplicate_widgets_are_rejected(self):
        for variant in ('orphan', 'missing', 'duplicate', 'no-form', 'wrong-page'):
            writer, _, field, widgets, form = fixture()
            if variant == 'orphan':
                orphan = DictionaryObject({key: value for key, value in widgets[0].items()})
                writer.pages[0]['/Annots'].append(writer._add_object(orphan))
            elif variant == 'missing':
                writer.pages[0]['/Annots'].pop()
            elif variant == 'duplicate':
                writer.pages[0]['/Annots'].append(field.indirect_reference)
            elif variant == 'no-form':
                writer.root_object.pop(N('/AcroForm'))
            else:
                field[N('/P')] = writer.add_blank_page(100, 100).indirect_reference
            with self.subTest(variant=variant):
                self.refused(writer)

    def test_mixed_field_and_widget_children_are_rejected(self):
        writer, _, field, _, _ = fixture(separate=True)
        child = DictionaryObject({N('/T'): T('child'), N('/Parent'): field.indirect_reference, N('/FT'): N('/Tx')})
        field['/Kids'].append(writer._add_object(child))
        self.refused(writer)

    def test_page_reference_requires_same_document_owner(self):
        writer, _, _, _, _ = fixture()
        first = PdfReader(io.BytesIO(saved(writer)))
        second = PdfReader(io.BytesIO(saved(writer)))
        page = first.pages[0]
        widget = page['/Annots'][-1].get_object()
        self.assertTrue(inventory._same_page(widget['/P'], page))
        self.assertEqual(page.indirect_reference.idnum, second.pages[0].indirect_reference.idnum)
        widget[N('/P')] = second.pages[0].indirect_reference
        with self.assertRaises(inventory.NativeFormInventoryError):
            inventory.native_form_inventory(first)

    def test_rectangles_and_text_limits_are_enforced(self):
        writer, _, field, _, _ = fixture()
        field[N('/Rect')] = ArrayObject([I(0), I(0), T('unknown'), I(10)])
        self.refused(writer)
        writer, _, field, _, _ = fixture()
        field[N('/TU')] = T('x' * (inventory.MAX_TEXT + 1))
        self.refused(writer, 'pdf_complexity_limit')

    def test_field_widget_and_depth_limits_are_enforced(self):
        writer, _, _, _, _ = fixture()
        for limit in ('MAX_FIELDS', 'MAX_WIDGETS', 'MAX_DEPTH', 'MAX_NODES'):
            with self.subTest(limit=limit), patch.object(inventory, limit, 0):
                self.refused(writer, 'pdf_complexity_limit')

    def test_verified_xfa_speech_uses_current_native_context(self):
        writer, _, _ = hybrid_fixture(label='  Existing authored description  ')
        report = self.report(writer)
        row = report['fields'][0]
        self.assertEqual(report['field_count'], 1)
        self.assertEqual(row['speech'], {'supported': True, 'text': '  Existing authored description  ',
            'disabled': True, 'priority': 'custom', 'source': 'xfa-assist'})
        before_id = row['fieldId']
        hybrid_forms.prepare_hybrid(writer)
        prepared = self.report(writer)['fields'][0]
        self.assertEqual(prepared['fieldId'], before_id)
        self.assertEqual(prepared['label'], '  Existing authored description  ')
        self.assertFalse(prepared['speech']['disabled'])

    def test_unsupported_speech_is_not_confused_with_enabled_speech(self):
        writer, _, form = hybrid_fixture(label='')
        row = self.report(writer)['fields'][0]
        self.assertFalse(row['speech']['supported'])
        # Missing verification capability is explicitly unknown, not enabled.
        with patch.object(inventory, 'inspect_hybrid', None):
            row = self.report(writer)['fields'][0]
            self.assertIsNone(row['speech']['disabled'])

    def test_unverified_xfa_fails_closed_and_inspection_is_read_only(self):
        writer, _, form = hybrid_fixture()
        source = saved(writer)
        inventory.native_form_inventory(writer)
        self.assertEqual(saved(writer), source)
        form['/Fields'].clear()
        self.refused(writer)


if __name__ == '__main__':
    unittest.main()
