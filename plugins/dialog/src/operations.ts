import { defineNativeOperation } from "@bunaway/plugin";
import {
  type DialogInstance,
  type FileDialogInstance,
  messageResultSchema,
  messageSchema,
  openFileSchema,
  resultSchema,
  saveFileSchema,
  selectFolderSchema,
} from "#dialog/contract";

const operation = defineNativeOperation<DialogInstance>();
const fileOperation = defineNativeOperation<FileDialogInstance>();
/** macOS shows the file and folder pickers only; `showMessage` is unsupported there. */
export const macosDialogOperations = {
  openFile: fileOperation({
    input: openFileSchema,
    output: resultSchema,
    handler: (input, { instance, source, signal, requestId }) =>
      instance.show("openFile", input, source, signal, requestId),
  }),
  selectFolder: fileOperation({
    input: selectFolderSchema,
    output: resultSchema,
    handler: (input, { instance, source, signal, requestId }) =>
      instance.show("selectFolder", input, source, signal, requestId),
  }),
  saveFile: fileOperation({
    input: saveFileSchema,
    output: resultSchema,
    handler: (input, { instance, source, signal, requestId }) =>
      instance.show("saveFile", input, source, signal, requestId),
  }),
};
/** Host-owned modal selection. Every operation needs its own policy grant. */
export const dialogOperations = {
  openFile: operation({
    input: openFileSchema,
    output: resultSchema,
    handler: (input, { instance, source, signal, requestId }) =>
      instance.show("openFile", input, source, signal, requestId),
  }),
  selectFolder: operation({
    input: selectFolderSchema,
    output: resultSchema,
    handler: (input, { instance, source, signal, requestId }) =>
      instance.show("selectFolder", input, source, signal, requestId),
  }),
  saveFile: operation({
    input: saveFileSchema,
    output: resultSchema,
    handler: (input, { instance, source, signal, requestId }) =>
      instance.show("saveFile", input, source, signal, requestId),
  }),
  showMessage: operation({
    input: messageSchema,
    output: messageResultSchema,
    handler: (input, { instance, source, signal, requestId }) =>
      instance.showMessage(input, source, signal, requestId),
  }),
};
