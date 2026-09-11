import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { inspectOffice, patchOffice } from '../lib/office-text.mjs';
for (const [format,part,tag] of [['docx','word/document.xml','w:t'],['pptx','ppt/slides/slide1.xml','a:t']]) {
  test(`${format}: modify one segment without changing other package entries`, async () => {
    const zip = new JSZip();
    zip.file(part, `<root><${tag}>原文&amp;文字</${tag}><${tag}>不能修改</${tag}></root>`);
    zip.file('media/image.png', Buffer.from([1,2,3]));
    const input = await zip.generateAsync({type:'nodebuffer'});
    const data = await inspectOffice(input);
    assert.equal(data.segments[0].text, '原文&文字');
    const output = await patchOffice(input, data.revision, [{id:data.segments[0].id,text:' 新文<&> '}]);
    const result = await inspectOffice(output);
    assert.equal(result.segments[0].text, ' 新文<&> ');
    assert.equal(result.segments[1].text, '不能修改');
    assert.deepEqual(await result.zip.file('media/image.png').async('nodebuffer'),Buffer.from([1,2,3]));
    await assert.rejects(patchOffice(input,'stale',[{id:data.segments[0].id,text:'x'}]), /已变化/);
    await assert.rejects(patchOffice(input,data.revision,[{id:'invalid',text:'x'}]), /无效/);
  });
}
