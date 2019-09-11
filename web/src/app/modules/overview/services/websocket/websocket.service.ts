/*
 * Copyright (c) 2019 VMware, Inc. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable } from '@angular/core';
import { Observable, Subject, Subscription } from 'rxjs';
import {
  NotifierService,
  NotifierSession,
  NotifierSignalType,
} from '../../../../services/notifier/notifier.service';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { delay, retryWhen, tap } from 'rxjs/operators';

interface WebsocketPayload {
  type: string;
  data?: {};
}

export type HandlerFunc = (data: {}) => void;

export interface BackendService {
  open();
  close();
  registerHandler(name: string, handler: HandlerFunc);
  sendMessage(messageType: string, payload: {});
  triggerHandler(name: string, payload: {});
}

@Injectable({
  providedIn: 'root',
})
export class WebsocketService implements BackendService {
  ws: WebSocket;
  handlers: { [key: string]: ({}) => void } = {};
  reconnected = new Subject<Event>();

  private notifierSession: NotifierSession;
  private errorSignalID: string;
  private subject: WebSocketSubject<unknown>;

  constructor(notifierService: NotifierService) {
    this.notifierSession = notifierService.createSession();
  }

  registerHandler(name: string, handler: (data: {}) => void): () => void {
    this.handlers[name] = handler;
    return () => delete this.handlers[name];
  }

  triggerHandler(name: string, payload: {}) {
    if (!this.handlers[name]) {
      throw new Error(`handler ${name} was not found`);
    }
    this.handlers[name](payload);
  }

  open() {
    this.createWebSocket('ws://localhost:7777/api/v1/stream')
      .pipe(
        retryWhen(errors =>
          errors.pipe(
            tap(_ => {
              const signalID = this.notifierSession.pushSignal(
                NotifierSignalType.ERROR,
                'Lost connection to Octant service. Retrying...'
              );
              if (this.errorSignalID === '') {
                this.errorSignalID = signalID;
              }
            }),
            delay(1000)
          )
        )
      )
      .subscribe(
        data => {
          this.notifierSession.removeAllSignals();
          this.parseWebsocketMessage(data);
        },
        err => console.error(err)
      );
  }

  close() {
    this.subject.unsubscribe();
  }

  private createWebSocket = uri => {
    return Observable.create(observer => {
      try {
        const subject = webSocket({
          url: uri,
          deserializer: ({ data }) => JSON.parse(data),
          openObserver: this.reconnected,
        });

        const subscription = subject
          .asObservable()
          .subscribe(
            data => observer.next(data),
            error => observer.error(error),
            () => observer.complete()
          );

        this.subject = subject;
        return () => {
          if (!subscription.closed) {
            subscription.unsubscribe();
          }
        };
      } catch (error) {
        observer.error(error);
      }
    });
  };

  sendMessage(messageType: string, payload: {}) {
    if (this.subject) {
      const data = {
        type: messageType,
        payload,
      };
      this.subject.next(data);
    }
  }

  private parseWebsocketMessage(data: {}) {
    try {
      const payload = data as WebsocketPayload;
      if (this.handlers.hasOwnProperty(payload.type)) {
        const handler = this.handlers[payload.type];
        handler(payload.data);
      } else {
        console.warn(
          `received websocket unknown message of type ${payload.type} with`,
          payload.data
        );
      }
    } catch (err) {
      console.error('parse websocket', err, data);
    }
  }
}