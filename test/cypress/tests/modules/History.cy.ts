import type EditorJS from '../../../../types/index';

describe('History module', function () {
  describe('undo()', function () {
    it('should undo text changes in a block', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'Initial text',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .click()
          .type('{selectall}Modified text')
          .then(() => {
            return editor.history.undo();
          })
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks.length).to.equal(1);
            expect(data.blocks[0].data.text).to.equal('Initial text');
          });
      });
    });

    it('should undo block removal', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'First block',
              },
            },
            {
              type: 'paragraph',
              data: {
                text: 'Second block',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        cy.get('[data-cy=editorjs]')
          .get('.ce-block')
          .eq(1)
          .click()
          .type('{backspace}')
          .then(() => {
            return editor.history.undo();
          })
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks.length).to.equal(2);
            expect(data.blocks[0].data.text).to.equal('First block');
            expect(data.blocks[1].data.text).to.equal('Second block');
          });
      });
    });

    it('should undo multiple typed lines without content reappearing', function () {
      cy.createEditor({
        tools: {
          paragraph: {
            config: {
              preserveBlank: true,
            },
          },
        },
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: { text: '' },
            },
            {
              type: 'paragraph',
              data: { text: '' },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .eq(0)
          .click()
          .type('Line 1')
          .wait(400)
          .then(() => {
            return editor.history.undo();
          })
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks[0].data.text).to.equal('');
          })
          .get('.ce-paragraph')
          .eq(1)
          .click()
          .type('Line 2')
          .wait(400)
          .then(() => {
            return editor.history.undo();
          })
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks[0].data.text).to.equal('');
            expect(data.blocks[1].data.text).to.equal('');
          });
      });
    });

    it('should not have initial blocks in the undo stack', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'Block one',
              },
            },
            {
              type: 'paragraph',
              data: {
                text: 'Block two',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        expect(editor.history.canUndo()).to.equal(false);

        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .eq(1)
          .click()
          .type('{selectall}Modified two')
          .wait(400)
          .then(() => {
            expect(editor.history.canUndo()).to.equal(true);

            return editor.history.undo();
          })
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks.length).to.equal(2);
            expect(data.blocks[0].data.text).to.equal('Block one');
            expect(data.blocks[1].data.text).to.equal('Block two');
          });
      });
    });
  });

  describe('redo()', function () {
    it('should redo text changes after undo', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'Initial text',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .click()
          .type('{selectall}Modified text')
          .then(() => {
            return editor.history.undo();
          })
          .then(() => {
            return editor.history.redo();
          })
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks.length).to.equal(1);
            expect(data.blocks[0].data.text).to.equal('Modified text');
          });
      });
    });
  });

  describe('canUndo() and canRedo()', function () {
    it('should report correct state for undo and redo', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'Initial text',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        expect(editor.history.canUndo()).to.equal(false);
        expect(editor.history.canRedo()).to.equal(false);

        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .click()
          .type('{selectall}Modified text')
          .wait(400)
          .then(() => {
            expect(editor.history.canUndo()).to.equal(true);
            expect(editor.history.canRedo()).to.equal(false);

            return editor.history.undo();
          })
          .then(() => {
            expect(editor.history.canUndo()).to.equal(false);
            expect(editor.history.canRedo()).to.equal(true);

            return editor.history.redo();
          })
          .then(() => {
            expect(editor.history.canUndo()).to.equal(true);
            expect(editor.history.canRedo()).to.equal(false);
          });
      });
    });
  });

  describe('keyboard shortcuts', function () {
    it('should undo with Ctrl+Z', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'Initial text',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .click()
          .type('{selectall}Modified text')
          .type('{ctrl+z}')
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks[0].data.text).to.equal('Initial text');
          });
      });
    });

    it('should redo with Ctrl+Shift+Z', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'Initial text',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .click()
          .type('{selectall}Modified text')
          .type('{ctrl+z}');

        cy.get('[data-cy=editorjs]')
          .find('.ce-paragraph')
          .click()
          .type('{ctrl+shift+z}')
          .then(async () => {
            const data = await editor.save();

            expect(data.blocks[0].data.text).to.equal('Modified text');
          });
      });
    });
  });

  describe('clear()', function () {
    it('should clear history stack', function () {
      cy.createEditor({
        data: {
          blocks: [
            {
              type: 'paragraph',
              data: {
                text: 'Initial text',
              },
            },
          ],
        },
      }).then((editor: EditorJS) => {
        cy.get('[data-cy=editorjs]')
          .get('.ce-paragraph')
          .click()
          .type('{selectall}Modified text')
          .wait(400)
          .then(() => {
            expect(editor.history.canUndo()).to.equal(true);
            editor.history.clear();
            expect(editor.history.canUndo()).to.equal(false);
          });
      });
    });
  });
});
