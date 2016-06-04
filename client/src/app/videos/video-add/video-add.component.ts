/// <reference path="../../../../typings/globals/jquery/index.d.ts" />
/// <reference path="../../../../typings/globals/jquery.fileupload/index.d.ts" />

import { Component, ElementRef, OnInit } from '@angular/core';
import { Router } from '@angular/router-deprecated';

import { BytesPipe } from 'angular-pipes/src/math/bytes.pipe';
import { PROGRESSBAR_DIRECTIVES } from 'ng2-bootstrap/components/progressbar';

import { AuthService, User } from '../../shared';

@Component({
  selector: 'my-videos-add',
  styles: [ require('./video-add.component.scss') ],
  template: require('./video-add.component.html'),
  directives: [ PROGRESSBAR_DIRECTIVES ],
  pipes: [ BytesPipe ]
})

export class VideoAddComponent implements OnInit {
  error: string = null;
  fileToUpload: any;
  progressBar: { value: number; max: number; } = { value: 0, max: 0 };
  user: User;

  private form: any;

  constructor(
    private authService: AuthService,
    private elementRef: ElementRef,
    private router: Router
  ) {}

  ngOnInit() {
    this.user = User.load();
    jQuery(this.elementRef.nativeElement).find('#videofile').fileupload({
      url: '/api/v1/videos',
      dataType: 'json',
      singleFileUploads: true,
      multipart: true,
      autoUpload: false,

      add: (e, data) => {
        this.form = data;
        this.fileToUpload = data['files'][0];
      },

      progressall: (e, data) => {
        this.progressBar.value = data.loaded;
        // The server is a little bit slow to answer (has to seed the video)
        // So we add more time to the progress bar (+10%)
        this.progressBar.max = data.total + (0.1 * data.total);
      },

      done: (e, data) => {
        this.progressBar.value = this.progressBar.max;
        console.log('Video uploaded.');

        // Print all the videos once it's finished
        this.router.navigate(['VideosList']);
      },

      fail: (e, data) => {
        const xhr = data.jqXHR;
        if (xhr.status === 400) {
          this.error = xhr.responseText;
        } else {
          this.error = 'Unknow error';
        }

        console.error(data);
      }
    });
  }

  uploadFile() {
    this.error = null;
    this.form.formData = jQuery(this.elementRef.nativeElement).find('form').serializeArray();
    this.form.headers = this.authService.getRequestHeader().toJSON();
    this.form.submit();
  }
}
